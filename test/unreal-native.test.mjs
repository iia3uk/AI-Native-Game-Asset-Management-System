import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { artifactHash } from '../core/conversion/artifacts.mjs'
import { createUnrealProject } from '../core/engines/unreal/bridge/project.mjs'
import { runUnrealCommandlet } from '../core/engines/unreal/bridge/run.mjs'
import { locateUnrealBridge } from '../core/engines/unreal/bridge/selection.mjs'
import { testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/unreal-native.py', import.meta.url))

test('native Unreal round-trip generates its mesh and texture in an installed editor and indexes their exports',
  { skip: process.env.ASSET_VIEWER_TEST_NATIVE_UNREAL !== '1', timeout: 540_000 }, async t => {
    const root = await testDirectory(t)
    const selection = await locateUnrealBridge({}, process.env.ASSET_VIEWER_TEST_UNREAL_VERSION)
    assert.ok(selection.editor, selection.issue)
    const { project } = await createUnrealProject(root, [])
    const script = join(root, 'create-fixture.py')
    await copyFile(fixture, script)
    const failure = await runUnrealCommandlet(selection.editor, root, { project, script })
    if (failure) {
      const log = await readFile(join(root, 'editor.log'), 'utf8').catch(() => '')
      assert.fail(failure + '\n' + log.slice(-6000))
    }
    const env = { ...process.env, ASSET_VIEWER_DATA_DIR: await testDirectory(t) }
    const execute = async (args, timeout = 15_000) => {
      const { stdout } = await run(process.execPath, [cli, ...args, '--json'], { env, timeout })
      return JSON.parse(stdout)
    }
    const inspected = await execute(['unreal-inspect', project])
    assert.equal(inspected.counts.editor, 2)
    const content = join(root, 'Content')
    const fingerprints = await Promise.all(inspected.entries.filter(entry => entry.type === 'uasset')
      .map(async entry => [entry.path, await artifactHash(join(content, entry.path))]))
    const { job, scan } = await execute(['package-import', project, '--mode', 'engine-assisted',
      '--unreal-version', selection.editor.version, '--export', 'fbx'], 250_000)
    assert.equal(job.status, 'completed')
    assert.equal(scan.status, 'completed')
    assert.equal(job.result.report.unreal.status, 'completed')
    const manifest = JSON.parse(await readFile(join(job.result.directory, 'manifest.json'), 'utf8'))
    const products = manifest.assets.flatMap(entry => entry.exports).filter(artifact => artifact.status === 'converted')
    const mesh = products.find(artifact => artifact.role === 'model')
    const texture = products.find(artifact => artifact.role === 'texture')
    assert.ok(mesh && texture, JSON.stringify(manifest))
    assert.equal(mesh.format, 'fbx')
    assert.equal(texture.format, 'png')
    assert.equal(texture.width, 4)
    assert.equal(texture.height, 4)
    for (const [path, hash] of fingerprints) assert.equal(await artifactHash(join(content, path)), hash)
    assert.equal((await execute(['search', '--library', job.result.library.id, '--kind', 'model'])).assets.length, 1)
  })
