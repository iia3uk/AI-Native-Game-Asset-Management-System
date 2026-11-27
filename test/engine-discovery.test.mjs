import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { discoverBlender } from '../core/engines/blender/discovery.mjs'
import { engineInventory } from '../core/engines/inventory.mjs'
import { discoverUnreal } from '../core/engines/unreal/discovery.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const unityPath = process.platform === 'win32' ? 'Editor/Unity.exe' :
  process.platform === 'darwin' ? 'Unity.app/Contents/MacOS/Unity' : 'Editor/Unity'
const unrealPath = process.platform === 'win32' ? 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe' :
  process.platform === 'darwin' ? 'Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor' :
    'Engine/Binaries/Linux/UnrealEditor'
const blenderName = process.platform === 'win32' ? 'blender.exe' : 'blender'
const guid = '{AB12CD34-12AB-34CD-56EF-876543ABCDEF}'

async function write(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
  return path
}

async function candidate(path) {
  await write(path, process.platform === 'win32' ? 'MZ synthetic test header only' : 'synthetic test file')
  await chmod(path, 0o755)
  return realpath(path)
}

test('engine discovery reports distinct installations and chooses concrete project matches without starting them', async t => {
  const root = await testDirectory(t)
  const standard = join(root, 'Unity Editors')
  const unityRoot = join(standard, '2099.3.12f1')
  const exact = await candidate(join(unityRoot, unityPath))
  await candidate(join(standard, '2099.3.9f1', unityPath))
  await candidate(join(standard, '2099.3.1b4', unityPath))
  await candidate(join(standard, '2099.4.0f1', unityPath))
  await write(join(standard, '2099.4.1f1', unityPath), 'not an executable')
  const unrealRoot = join(root, 'Unreal Source Build')
  const unrealEditor = await candidate(join(unrealRoot, unrealPath))
  await write(join(unrealRoot, 'Engine/Build/Build.version'), JSON.stringify({
    MajorVersion: 5, MinorVersion: 7, PatchVersion: 4, Changelist: 900,
  }))
  const blenderRoot = join(root, 'Blender 4.3')
  const blender = await candidate(join(blenderRoot, blenderName))
  const unityProject = join(root, 'Project')
  const projectVersion = join(unityProject, 'ProjectSettings/ProjectVersion.txt')
  await write(projectVersion, 'm_EditorVersion: 2099.3.12f1\nm_EditorVersionWithRevision: 2099.3.12f1 (test)\n')
  const unrealProject = await write(join(root, 'Offroad.uproject'), JSON.stringify({ EngineAssociation: '5.7' }))
  const env = {
    ASSET_VIEWER_UNITY_ROOTS: ['relative path', standard, unityRoot].join(delimiter),
    ASSET_VIEWER_UNREAL_ROOTS: unrealRoot, ASSET_VIEWER_BLENDER: blender,
  }
  const inventory = await engineInventory({ env, home: root, unityProject, unrealProject })
  assert.equal(inventory.unity.filter(editor => editor.executable === exact).length, 1)
  assert.equal(inventory.unity.filter(editor => editor.version?.startsWith('2099.')).length, 4)
  assert.equal(inventory.match.unity.status, 'exact')
  assert.equal(inventory.match.unity.candidate.executable, exact)
  assert.equal(inventory.match.unreal.candidate.executable, unrealEditor)
  assert.equal(inventory.match.unreal.candidate.changelist, 900)
  assert.equal(inventory.blender[0].executable, blender)
  assert.equal(inventory.blender[0].version, '4.3')
  await write(projectVersion, 'm_EditorVersion: 2099.3.11f1\n')
  const fallback = await engineInventory({ env, home: root, unityProject })
  assert.equal(fallback.match.unity.status, 'same-series')
  assert.equal(fallback.match.unity.candidate.version, '2099.3.12f1')
  await write(projectVersion, 'm_EditorVersion: 2099.9.1f1\n')
  const missing = await engineInventory({ env, home: root, unityProject })
  assert.deepEqual(missing.match.unity, { status: 'unavailable', requested: '2099.9.1f1', candidate: null })
})

test('Windows launcher inventory and registration preserve Unreal project associations', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await testDirectory(t)
  const unreal = join(root, 'Elsewhere', 'UE_5.7')
  const executable = await candidate(join(unreal, unrealPath))
  await write(join(unreal, 'Engine/Build/Build.version'), '{"MajorVersion":5,"MinorVersion":7,"PatchVersion":2}')
  await write(join(root, 'Epic/UnrealEngineLauncher/LauncherInstalled.dat'),
    JSON.stringify({ InstallationList: [{ AppName: 'UE_5.7', InstallLocation: unreal }] }))
  const registry = async () => [{ name: guid, path: unreal }]
  const installations = await discoverUnreal({ ProgramData: root }, root, registry)
  assert.equal(installations.length, 1)
  assert.equal(installations[0].version, '5.7.2')
  assert.equal(installations[0].executable, executable)
  assert.deepEqual(installations[0].associations, ['5.7', '5.7.2', guid])
})

test('Steam Blender discovery follows local library folders without interpreting the manifest as commands', async t => {
  const root = await testDirectory(t)
  const steam = process.platform === 'win32' ? join(root, 'Steam') : process.platform === 'darwin'
    ? join(root, 'Library/Application Support/Steam') : join(root, '.local/share/Steam')
  const other = join(root, 'Additional Library')
  const entry = process.platform === 'darwin' ? 'steamapps/common/Blender/Blender.app/Contents/MacOS/Blender' :
    'steamapps/common/Blender/' + blenderName
  const executable = await candidate(join(other, entry))
  await write(join(steam, 'steamapps/libraryfolders.vdf'), '"libraryfolders"\n{\n  "1"\n  {\n    "path" ' + JSON.stringify(other) + '\n  }\n}\n')
  const registry = async () => [{ name: 'SteamPath', path: steam }]
  const installations = await discoverBlender({}, root, registry)
  assert.equal(installations.find(item => item.executable === executable)?.source, 'steam')
})

test('CLI and HTTP expose the same installations without creating an index', async t => {
  const root = await testDirectory(t)
  const path = await candidate(join(root, 'Blender 4.3', blenderName))
  const data = join(root, 'data')
  const settings = { ASSET_VIEWER_BLENDER: path, ASSET_VIEWER_DATA_DIR: data }
  const server = await startServer(root, settings)
  try {
    const { stdout } = await run(process.execPath, [cli, 'engines', '--json'], {
      env: { ...process.env, ...settings }, windowsHide: true,
    })
    const inventory = JSON.parse(stdout)
    assert.equal(inventory.blender[0].executable, path)
    assert.equal(inventory.blender[0].source, 'configured')
    const response = await server.request('/api/index/engines')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), inventory)
    await assert.rejects(stat(join(data, 'index.sqlite')), { code: 'ENOENT' })
  } finally {
    await server.close()
  }
})
