import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { locateBatchBlender } from '../core/engines/blender/batch.mjs'
import { locateUnityBridge } from '../core/engines/unity/bridge/run.mjs'
import { bundleDecoderRevision, bundleResult } from '../core/engines/unity/bundle/protocol.mjs'
import { locateBundleWorker } from '../core/engines/unity/bundle/run.mjs'
import { buildAssetBundleFixture } from './fixtures/unity-bundle/project.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'
import { verifyBundleAudio } from './unity-bundle/audio.mjs'
import { readTexture } from './unity-bundle/png.mjs'
import { verifyBundleSprites } from './unity-bundle/sprites.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))

function client(data) {
  const env = { ...process.env, ASSET_VIEWER_DATA_DIR: data }
  return async (...args) => {
    try {
      return JSON.parse((await run(process.execPath, [cli, ...args, '--json'], { env, windowsHide: true })).stdout)
    } catch (error) {
      if (error.code === 1 && error.stdout) return JSON.parse(error.stdout)
      throw error
    }
  }
}

async function waitForImport(server, path, hash, formats = []) {
  const request = await server.post('/api/index/packages/import', { path, hash, formats })
  assert.equal(request.status, 202)
  const { job } = await request.json()
  return waitForJob(server, job.id)
}

async function waitForJob(server, id) {
  const deadline = Date.now() + 25_000
  do {
    const response = await server.request('/api/index/jobs/' + id)
    assert.equal(response.status, 200)
    const { job } = await response.json()
    if (!['pending', 'running'].includes(job.status)) return job
    await delay(100)
  } while (Date.now() < deadline)
  assert.fail('UnityFS job did not reach a terminal state.')
}

test('UnityFS validates decoder reports and rejects non-bundle sources without touching the index', async t => {
  const root = await testDirectory(t)
  const path = join(root, 'Fixture.bundle')
  const data = join(root, 'data')
  await writeFile(path, Buffer.alloc(128, 0xff))
  const query = client(data)
  assert.deepEqual(await query('unity-bundle', path, '--inspect'), { status: 'failed', issue: 'unity-bundle-signature' })
  await assert.rejects(readdir(data), { code: 'ENOENT' })

  const row = { member: 'CAB-123', pathId: '7268794857742934074', classId: 28, name: 'Albedo',
    status: 'decoded', issue: null, width: 4, height: 4, output: 0, format: 'rgba', bytes: 64,
    textureEncoding: 'dxt5', textureStorage: 'bundle-member' }
  const report = { protocol: 1, decoderRevision: bundleDecoderRevision, status: 'completed', format: 8,
    unityVersion: '6000.3.10f1', assets: [row] }
  assert.equal(bundleResult(report, false).assets[0].file, '0.rgba')
  for (const invalid of [{ ...row, member: '../CAB' }, { ...row, output: 4 }, { ...row, width: 3000 },
    { ...row, textureStorage: 'sidecar' }, { ...row, textureEncoding: 'other' }, { ...row, bytes: 63 }]) {
    assert.equal(bundleResult({ ...report, assets: [invalid] }, false), null)
  }
  assert.equal(bundleResult({ ...report, decoderRevision: bundleDecoderRevision - 1 }, false), null)
  assert.equal(bundleResult(report, true), null)
  assert.equal(bundleResult({ ...report, assets: [row, { ...row, output: 1 }] }, false), null)
  const sprite = { ...row, pathId: '-502', classId: 213, output: 1, width: 3, height: 2, bytes: 24,
    sprite: { texturePathId: row.pathId, x: 1, y: 2 } }
  assert.deepEqual(bundleResult({ ...report, assets: [row, sprite] }, false).assets[1].sprite, sprite.sprite)
  for (const invalid of [null, { ...sprite.sprite, texturePathId: -1 }, { ...sprite.sprite, texturePathId: '999' },
    { ...sprite.sprite, x: -1 }, { ...sprite.sprite, y: 2047 }, { ...sprite.sprite, x: 1.5 }]) {
    assert.equal(bundleResult({ ...report, assets: [row, { ...sprite, sprite: invalid }] }, false), null)
  }
  const audio = { member: 'CAB-123', pathId: '-110', classId: 83, status: 'decoded', issue: null,
    name: 'Sound', format: 'wav', bytes: 444, output: 0, audio: { channels: 2, sampleRate: 44100, frames: 100 } }
  assert.deepEqual(bundleResult({ ...report, assets: [audio] }, false).assets[0].audio, audio.audio)
  for (const invalid of [null, { ...audio.audio, channels: 6 }, { ...audio.audio, sampleRate: 0 },
    { ...audio.audio, frames: 0 }, { ...audio.audio, frames: 32 * 1024 ** 2 }, { ...audio.audio, frames: 101 }]) {
    assert.equal(bundleResult({ ...report, assets: [{ ...audio, audio: invalid }] }, false), null)
  }
})

test('Unity builds native UnityFS bundles and the independent worker indexes textures, sprites, meshes and audio', {
  skip: process.env.ASSET_VIEWER_TEST_NATIVE_BUNDLE !== '1', timeout: 180_000,
}, async t => {
  const root = await testDirectory(t)
  const version = process.env.ASSET_VIEWER_TEST_UNITY_VERSION || '6000.3.10f1'
  const { editor, match } = await locateUnityBridge(version)
  assert.equal(match, 'exact', 'The native fixture requires the requested Unity Editor version')
  const worker = await locateBundleWorker()
  assert.ok(worker, 'Run npm run build:unity-bundle before the native test')
  const input = await buildAssetBundleFixture(root, editor)
  const before = await readFile(input)
  const data = join(root, 'data')
  const query = client(data)
  assert.ok(before.subarray(0, 8).equals(Buffer.from('UnityFS\0')))
  const inspection = await query('unity-bundle', input, '--inspect')
  assert.equal(inspection.status, 'completed', JSON.stringify(inspection))
  assert.equal(inspection.unityVersion, version)
  assert.equal(inspection.format, 8)
  assert.equal(inspection.total, 6)
  assert.equal(inspection.decoderRevision, bundleDecoderRevision)
  const texture = inspection.assets.find(asset => asset.name === 'Albedo')
  assert.deepEqual([texture.status, texture.width, texture.height], ['available', 4, 4])
  const mesh = inspection.assets.find(asset => asset.format === 'glb')
  assert.deepEqual([mesh.status, mesh.vertices, mesh.triangles], ['available', 6, 2])
  assert.ok(inspection.assets.some(asset => asset.classId === 43 && asset.status === 'unsupported'))
  await assert.rejects(readdir(data), { code: 'ENOENT' })

  const output = await query('unity-bundle', input, '--fbx')
  assert.equal(output.converted, 5, JSON.stringify(output))
  assert.equal(output.skipped, 1)
  const manifest = JSON.parse(await readFile(join(output.output, 'manifest.json'), 'utf8'))
  assert.equal(manifest.source.sha256, createHash('sha256').update(before).digest('hex'))
  assert.equal(manifest.decoderRevision, bundleDecoderRevision)
  const { entry, pixel } = await readTexture(manifest, output.output, 'Albedo')
  assert.equal(entry.pathId, texture.pathId)
  assert.deepEqual([pixel(0, 0), pixel(1, 3)], [[0, 96, 96, 255], [32, 0, 96, 255]])
  const dxt1 = await readTexture(manifest, output.output, 'InlineDXT1')
  assert.equal(dxt1.entry.textureStorage, 'inline')
  assert.deepEqual(Array.from({ length: 8 }, (_, x) => dxt1.pixel(x, 0)), [
    [255, 0, 0, 255], [0, 0, 255, 255], [170, 0, 85, 255], [85, 0, 170, 255],
    [0, 0, 0, 255], [0, 255, 0, 255], [0, 127, 0, 255], [0, 0, 0, 0],
  ])
  const dxt5 = await readTexture(manifest, output.output, 'InlineDXT5')
  assert.equal(dxt5.entry.textureStorage, 'inline')
  assert.deepEqual(dxt5.pixel(3, 3), [170, 0, 85, 157])
  assert.deepEqual(dxt5.pixel(6, 0), [85, 0, 170, 0])
  assert.deepEqual(dxt5.pixel(7, 0), [170, 0, 85, 255])
  const streamed = await readTexture(manifest, output.output, 'StreamedDXT5')
  assert.equal(streamed.entry.textureStorage, 'bundle-member')
  assert.deepEqual([streamed.entry.width, streamed.entry.height], [512, 512])
  for (const [actual, expected] of [
    [streamed.pixel(20, 20), [0, 255, 0, 204]], [streamed.pixel(20, 490), [255, 0, 0, 51]],
  ]) assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]) <= 8), String(actual))
  const { assets } = await query('search', 'Albedo', '--library', output.library.id)
  assert.equal(assets.length, 1)
  assert.equal(assets[0].ext, 'png')
  assert.equal((await query('search', 'StreamedDXT5', '--library', output.library.id)).assets[0].ext, 'png')

  const model = manifest.assets.find(asset => asset.pathId === mesh.pathId)
  const readProduct = async product => Uint8Array.from(await readFile(join(output.output, product.path))).buffer
  const glb = await new GLTFLoader().parseAsync(await readProduct(model.artifact), '')
  const geometries = []
  glb.scene.traverse(node => { if (node.isMesh) geometries.push(node.geometry) })
  assert.equal(geometries.length, 2)
  assert.deepEqual([...geometries[0].index.array], [0, 2, 1])
  assert.deepEqual([...geometries[1].index.array], [3, 5, 4])
  assert.deepEqual([...geometries[1].attributes.position.array.subarray(9, 12)], [2, 0, -1])
  assert.equal(geometries[0].attributes.normal.getZ(0), 1)
  assert.deepEqual([...geometries[0].attributes.uv.array.subarray(0, 6)], [0, 1, 0, 0, 1, 1])
  assert.equal((await query('search', 'Triangle', '--library', output.library.id)).assets.some(asset => asset.ext === 'glb'), true)
  const [fbx] = model.exports
  if (await locateBatchBlender()) {
    assert.equal(fbx.status, 'converted', JSON.stringify(fbx))
    let triangles = 0
    const imported = new FBXLoader().parse(await readProduct(fbx), '')
    imported.traverse(node => {
      if (node.isMesh) triangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3
    })
    assert.equal(triangles, 2)
  } else {
    assert.deepEqual(fbx, { format: 'fbx', status: 'requires-tool', issue: 'blender-unavailable' })
  }

  const bad = join(root, 'Broken.bundle')
  await writeFile(bad, before.subarray(0, -1))
  assert.deepEqual(await query('unity-bundle', bad, '--inspect'),
    { status: 'failed', issue: 'unity-bundle-metadata-size' })
  assert.deepEqual(await readFile(input), before)
  assert.deepEqual(await readdir(join(output.output, '..')), [output.output.split(/[\\/]/).at(-1)])

  const uncompressed = await readFile(join(root, 'Bundles', 'uncompressed', 'fixture.bundle'))
  const streamPath = /archive:\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\.resS/.exec(uncompressed.toString('latin1'))
  assert.ok(streamPath, 'Unity should write an internal resource reference')
  assert.equal(uncompressed.readUInt32LE(streamPath.index - 4), streamPath[0].length)
  for (const [issue, edit] of [
    ['path', bytes => bytes.write('../outside/', streamPath.index, 'ascii')],
    ['range', bytes => bytes.writeUInt32LE(0xffff_fffe, streamPath.index - 8)],
  ]) {
    const corrupted = Buffer.from(uncompressed)
    edit(corrupted)
    const path = join(root, 'bad-stream-' + issue + '.bundle')
    await writeFile(path, corrupted)
    const report = await query('unity-bundle', path, '--inspect')
    assert.equal(report.status, 'completed', JSON.stringify(report))
    assert.ok(report.assets.some(asset => asset.issue === 'unity-bundle-texture-stream-' + issue))
    assert.ok(report.assets.some(asset => asset.name === 'Albedo' && asset.status === 'available'))
  }

  const alternate = join(root, 'Container.bin')
  await writeFile(alternate, before)
  const server = await startServer(root)
  try {
    const inspected = await server.post('/api/index/packages/inspect', { path: alternate })
    assert.equal(inspected.status, 200)
    const { package: plan } = await inspected.json()
    assert.deepEqual([plan.format, plan.containerVersion, plan.unityVersion, plan.hash], ['unityfs', 8, version, manifest.source.sha256])
    assert.equal(plan.assets.find(asset => asset.name === 'Albedo').pathId, texture.pathId)
    const disallowed = await server.post('/api/index/packages/import', { path: alternate, hash: plan.hash, mode: 'engine-assisted' })
    assert.equal(disallowed.status, 400)

    const cached = await waitForImport(server, alternate, plan.hash, ['fbx'])
    assert.equal(cached.status, 'completed', cached.error)
    assert.equal(cached.result.reused, true)
    assert.equal(cached.result.library.id, output.library.id)
    assert.equal(cached.result.report.packageFormat, 'unityfs')
    assert.deepEqual(cached.result.report.counts, { converted: 5, unsupported: 1 })
    assert.equal((await waitForJob(server, cached.result.scanJobId)).status, 'completed')
    const page = await (await server.request('/api/index/jobs/' + cached.id + '/manifest')).json()
    assert.deepEqual(page.assets, manifest.assets)

    const fresh = await waitForImport(server, alternate, plan.hash)
    assert.equal(fresh.status, 'completed', fresh.error)
    assert.equal(fresh.result.reused, false)
    assert.notEqual(fresh.result.directory, output.output)
    assert.equal((await waitForJob(server, fresh.result.scanJobId)).status, 'completed')
    const results = await (await server.request('/api/index/search?kind=model&library=' + fresh.result.library.id)).json()
    assert.deepEqual(results.assets.map(asset => asset.ext), ['glb'])
    const reopened = await server.post('/api/index/assets/' + results.assets[0].id + '/open', {})
    assert.equal(reopened.status, 200)
    const { folder, fileId } = await reopened.json()
    const resource = folder.resources.find(item => item.id === fileId)
    const served = await server.request(resource.url)
    assert.equal(served.status, 200)
    assert.equal(Buffer.from(await served.arrayBuffer()).toString('ascii', 0, 4), 'glTF')

    await writeFile(alternate, before.subarray(0, -1))
    const changed = await waitForImport(server, alternate, plan.hash)
    assert.equal(changed.status, 'failed')
    assert.match(changed.error, /изменился после анализа/)
    await writeFile(alternate, before)
    await writeFile(join(output.output, entry.artifact.path), 'tampered cache')
    const corrupt = await waitForImport(server, alternate, plan.hash, ['fbx'])
    assert.equal(corrupt.status, 'failed')
    assert.match(corrupt.error, /Кеш импорта UnityFS повреждён/)
    assert.deepEqual(await readFile(alternate), before)
  } finally {
    await server.close()
  }
  const spriteData = join(root, 'sprite-data')
  await verifyBundleSprites(root, spriteData, client(spriteData))
  const audioData = join(root, 'audio-data')
  await verifyBundleAudio(root, audioData, client(audioData), worker)
})
