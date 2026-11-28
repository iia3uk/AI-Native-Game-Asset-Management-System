import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { cookedMaterial } from '../fixtures/unreal-cooked-material.mjs'
import { cookedSoundWave } from '../fixtures/unreal-cooked-soundwave.mjs'
import { cookedStaticMesh } from '../fixtures/unreal-cooked-static-mesh.mjs'
import { cookedTexture } from '../fixtures/unreal-cooked-texture.mjs'
import { readPngRgb } from '../../core/files/png-rgb.mjs'
import { rgbaSourceRows, sourceArtPackage, sourceArtPng } from '../fixtures/unreal-source-texture.mjs'
import { zenOgg } from '../fixtures/unreal-zen-audio.mjs'
import { testDirectory } from '../server-fixture.mjs'

const run = promisify(execFile)
const packaged = resolve(process.env.ASSET_VIEWER_TEST_PACKAGED_DIR || 'release/win-unpacked')

test('The packaged CLI converts an Unreal Content folder with the bundled decoder', { timeout: 30_000 }, async t => {
  const root = await testDirectory(t)
  const content = join(root, 'Content')
  await mkdir(content)
  const source = [
    { path: 'EditorColor.uasset', content: sourceArtPackage(sourceArtPng(), { earlyTexture: true, compressed: true }) },
    ...cookedTexture({ name: 'CookedColor', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([86]), external: true }),
    ...cookedMaterial({ name: 'CookedPaint', textures: [{ parameter: 'BaseColor', value: '/Game/CookedColor' }] }),
    ...cookedStaticMesh({ name: 'CookedModel', external: true }),
    ...cookedSoundWave({ name: 'CookedTone', streaming: true, format: 'OGG', payload: zenOgg }),
  ]
  await Promise.all(source.map(file => writeFile(join(content, file.path), file.content)))
  const executable = join(packaged, 'Asset Viewer.exe')
  const cli = join(packaged, 'resources', 'app.asar', 'scripts', 'asset-viewer.mjs')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ASSET_VIEWER_DATA_DIR: join(root, 'data'), ASSET_VIEWER_CUE4PARSE: '' }
  const { stdout } = await run(executable, [cli, 'package-import', content, '--export', 'glb', '--json'],
    { env, windowsHide: true, timeout: 18_000 })
  const { job, scan } = JSON.parse(stdout)
  assert.equal(job.status, 'completed', job.error)
  assert.equal(scan.status, 'completed', scan.error)
  assert.equal(job.result.report.unrealCooked.textures.converted, 1)
  assert.equal(job.result.report.unrealCooked.materials.converted, 1)
  assert.deepEqual(job.result.report.unrealCooked.audio, { converted: 1, skipped: 0, failed: 0 })
  assert.deepEqual(job.result.report.unrealCooked.meshes.derivatives, { fbx: 0, glb: 2 })
  const output = job.result.directory
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json')))
  const [sourceArt] = manifest.assets.find(row => row.sourcePath === 'EditorColor.uasset').exports
  assert.equal(sourceArt.channelOrder, 'bgra-to-rgba')
  assert.deepEqual(readPngRgb(await readFile(join(output, sourceArt.path))).rows, rgbaSourceRows)
  const [texture] = manifest.assets.find(row => row.sourcePath === 'CookedColor.uasset').exports
  const [material] = manifest.assets.find(row => row.sourcePath === 'CookedPaint.uasset').exports
  const model = manifest.assets.find(row => row.sourcePath === 'CookedModel.uasset').exports
  const [audio] = manifest.assets.find(row => row.sourcePath === 'CookedTone.uasset').exports
  assert.deepEqual(await readFile(join(output, audio.path)), zenOgg)
  const previews = model.filter(entry => entry.format === 'glb')
  assert.deepEqual(previews.map(entry => [entry.lod, entry.metrics.triangles]), [[0, 2], [1, 1]])
  for (const preview of previews) {
    assert.equal((await readFile(join(output, preview.path))).subarray(0, 4).toString(), 'glTF')
  }
  assert.equal((await readFile(join(output, texture.path))).subarray(1, 4).toString(), 'PNG')
  const description = JSON.parse(await readFile(join(output, material.path)))
  assert.equal(description.bindings[0].path, texture.path)
  for (const file of source) assert.deepEqual(await readFile(join(content, file.path)), file.content)
})
