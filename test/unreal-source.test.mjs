import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ExportArtifacts } from '../core/conversion/artifacts.mjs'
import { publishUnrealArtifacts } from '../core/conversion/unreal/editor.mjs'
import { stageUnrealContent, unrealMountName } from '../core/engines/unreal/bridge/inputs.mjs'
import { createUnrealProject, unrealBridgeScripts } from '../core/engines/unreal/bridge/project.mjs'
import { readUnrealResults } from '../core/engines/unreal/bridge/protocol.mjs'
import { unrealEditorCommand } from '../core/engines/unreal/bridge/run.mjs'
import { ioStoreHeader, pakFooter } from '../core/packages/unreal/containers.mjs'
import { unrealPackageSummary } from '../core/packages/unreal/package-summary.mjs'
import { unrealSource } from '../core/packages/unreal/source.mjs'
import { packagePrefix } from './fixtures/unreal-loose.mjs'
import { testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))

async function put(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  return path
}

test('classifies bounded stock UE4 and UE5 package prefixes', () => {
  for (const [layout, ue4, ue5] of [[-7, 522, 0], [-8, 522, 1008], [-9, 522, 1016]]) {
    assert.deepEqual(unrealPackageSummary(packagePrefix(layout, ue4, ue5, 0), 256),
      { storage: 'editor', layout, ue4, ue5 })
    assert.equal(unrealPackageSummary(packagePrefix(layout, ue4, ue5, 0x200), 256).storage, 'cooked')
    assert.equal(unrealPackageSummary(packagePrefix(layout, ue4, ue5, 0x80000000), 256).storage, 'cooked')
    assert.equal(unrealPackageSummary(packagePrefix(layout, ue4, ue5, 0x00200000), 256).issue, 'unreal-package-editor-excluded')
  }
  assert.equal(unrealPackageSummary(packagePrefix(-8, 0, 0, 0), 256).storage, 'unversioned')
  assert.equal(unrealPackageSummary(packagePrefix(-8, 522, 2000, 0), 256).issue, 'unreal-package-version')
  assert.equal(unrealPackageSummary(packagePrefix(-8, 522, 1008, 0), 50).issue, 'unreal-package-summary')
  assert.equal(unrealPackageSummary(Buffer.from('not an Unreal file'), 18).issue, 'unreal-package-signature')
})

test('recognizes bounded Pak and IoStore headers with encryption indicators', () => {
  const footer = Buffer.alloc(56)
  footer[11] = 1
  footer.writeUInt32LE(0x5a6f12e1, 12)
  footer.writeInt32LE(8, 16)
  footer.writeBigInt64LE(40n, 20)
  footer.writeBigInt64LE(60n, 28)
  assert.deepEqual(pakFooter(footer, 512), { version: 8, encryptedIndex: true })
  assert.equal(pakFooter(footer, footer.length), null)
  const toc = Buffer.alloc(144)
  toc.write('-==--==--==--==-')
  toc[16] = 5
  toc.writeUInt32LE(144, 20)
  toc.writeUInt32LE(9, 24)
  toc[80] = 3
  assert.deepEqual(ioStoreHeader(toc, 192), { version: 5, flags: 3, encrypted: true, chunks: 9 })
  assert.equal(ioStoreHeader(toc.subarray(1), 192), null)
})

test('Unreal CLI inspection stays inside Content and excludes malformed files from the editor stage', async t => {
  const root = await testDirectory(t)
  const project = await put(join(root, 'Unreal Project', 'Fixture.uproject'),
    JSON.stringify({ FileVersion: 3, EngineAssociation: '5.997.998', Modules: [{ Name: 'ExternalCode' }] }))
  const bad = await put(join(dirname(project), 'Content', 'Props', 'Malformed.uasset'), 'intentionally invalid negative test')
  await put(join(dirname(project), 'Content', 'AssetRegistry.bin'), '')
  await put(join(dirname(project), 'Content', 'Props', 'startup.py'), 'raise RuntimeError()')
  await put(join(dirname(project), 'Plugins', 'ignored.uplugin'), '{}')
  const alias = join(dirname(project), 'Content', 'External')
  await symlink(dirname(project), alias, 'junction').catch(error => {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error
  })
  const env = { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'data') }
  const inspected = JSON.parse((await run(process.execPath, [cli, 'unreal-inspect', project, '--json'], { env })).stdout)
  assert.equal(inspected.association, '5.997.998')
  assert.deepEqual(inspected.counts, { companion: 1, unknown: 1 })
  assert.equal(inspected.entries.find(entry => entry.path === 'Props/Malformed.uasset').issue, 'unreal-package-signature')
  const stage = join(root, 'stage')
  await mkdir(stage)
  const result = await stageUnrealContent(await unrealSource(project), stage)
  assert.deepEqual(result.targets, [])
  assert.ok(result.issues.some(entry => entry.issue === 'unreal-package-signature'))
  assert.deepEqual(await readdir(stage), [])
  assert.equal(await readFile(bad, 'utf8'), 'intentionally invalid negative test')
  for (const invalid of ['../Outside.uasset', 'NUL.uasset', 'folder//Name.uasset', 'a:b.uasset']) {
    assert.equal(unrealMountName(invalid), null)
  }
  assert.equal(unrealMountName('Props/SM_Table.uasset'), '/Game/Props/SM_Table')
  await assert.rejects(run(process.execPath, [cli, 'unreal-export', project, '--json'], { env }), error => {
    assert.equal(error.code, 1)
    assert.equal(JSON.parse(error.stdout).issue, 'unreal-version-unavailable')
    return true
  })
  await assert.rejects(readdir(env.ASSET_VIEWER_DATA_DIR), { code: 'ENOENT' })
})

test('isolated Unreal request and validated publication use separate modules and fixed paths', async t => {
  const root = await testDirectory(t)
  const id = 'a'.repeat(32)
  const targets = [{ id, packageName: '/Game/Mat', sourcePath: 'Mat.uasset', files: [] }]
  const { project, script } = await createUnrealProject(root, targets)
  assert.deepEqual(JSON.parse(await readFile(project, 'utf8')), { FileVersion: 3,
    DisableEnginePluginsByDefault: true, Plugins: [{ Name: 'PythonScriptPlugin', Enabled: true }] })
  assert.deepEqual((await readdir(dirname(script))).sort(), [...unrealBridgeScripts].sort())
  const command = unrealEditorCommand({ executable: process.execPath, project, script,
    log: join(root, 'engine log.txt'), platform: 'win32' })
  assert.equal(command.options.windowsVerbatimArguments, true)
  assert.equal(command.options.argv0, '"' + process.execPath + '"')
  assert.ok(command.args.includes('-script="' + script + '"'))
  if (process.platform === 'win32') {
    const launched = spawnSync(process.execPath, ['-p', '42'], { ...command.options, encoding: 'utf8' })
    assert.equal(launched.stdout.trim(), '42', launched.stderr)
  }
  const objectPath = '/Game/Mat.Mat'
  const material = { number: 0, role: 'material', format: 'json', name: 'Mat', className: 'Material', objectPath }
  const invalidTexture = { number: 1, role: 'texture', format: 'png', name: 'Tex', className: 'Texture2D',
    objectPath: '/Game/Mat.Tex', width: 2, height: 2 }
  const outputRoot = join(root, 'BridgeOutput')
  const file = await put(join(outputRoot, id, '0.json'), JSON.stringify({ objectPath, className: 'Material', textures: [] }))
  await put(join(outputRoot, id, '1.png'), 'invalid texture')
  const response = { version: 1, engineVersion: '5.7.1-1+++UE5+Release-5.7',
    results: [{ id, products: [material, invalidTexture], dependencies: [] }] }
  const report = await put(join(root, 'bridge-result.json'), JSON.stringify(response))
  const editor = { version: '5.7.1' }
  const parsed = await readUnrealResults(root, targets, editor)
  const result = parsed.results.get(id)
  const published = join(root, 'Published')
  await mkdir(published)
  const products = await publishUnrealArtifacts(id, result, { outputRoot, summary: parsed }, new ExportArtifacts(published))
  assert.equal(products[0].path, 'Materials/' + id + '/material-0.json')
  assert.match(products[0].sha256, /^[0-9a-f]{64}$/)
  assert.equal(products[1].issue, 'unreal-output-invalid')
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  assert.equal(await readUnrealResults(root, targets, { version: '5.7.2' }), null)
  material.format = '../../outside'
  await writeFile(report, JSON.stringify(response))
  assert.equal(await readUnrealResults(root, targets, editor), null)
})
