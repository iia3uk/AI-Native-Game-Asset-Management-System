import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { locateBatchBlender } from '../core/engines/blender/batch.mjs'
import { locateUnityBridge } from '../core/engines/unity/bridge/run.mjs'
import { bundleResult } from '../core/engines/unity/bundle/protocol.mjs'
import { locateBundleWorker } from '../core/engines/unity/bundle/run.mjs'
import { buildAssetBundleFixture } from './fixtures/unity-bundle/project.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

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
    status: 'decoded', issue: null, width: 4, height: 4, output: 0 }
  const report = { protocol: 1, status: 'completed', format: 8, unityVersion: '6000.3.10f1', assets: [row] }
  assert.equal(bundleResult(report, false).assets[0].file, '0.rgba')
  for (const invalid of [{ ...row, member: '../CAB' }, { ...row, output: 4 }, { ...row, width: 3000 }]) {
    assert.equal(bundleResult({ ...report, assets: [invalid] }, false), null)
  }
  assert.equal(bundleResult(report, true), null)
  assert.equal(bundleResult({ ...report, assets: [row, { ...row, output: 1 }] }, false), null)
})

test('Unity builds a native UnityFS bundle and the independent worker indexes decoded texture and static mesh outputs', {
  skip: process.env.ASSET_VIEWER_TEST_NATIVE_BUNDLE !== '1', timeout: 180_000,
}, async t => {
  const root = await testDirectory(t)
  const version = process.env.ASSET_VIEWER_TEST_UNITY_VERSION || '6000.3.10f1'
  const { editor, match } = await locateUnityBridge(version)
  assert.equal(match, 'exact', 'The native fixture requires the requested Unity Editor version')
  assert.ok(await locateBundleWorker(), 'Run npm run build:unity-bundle before the native test')
  const input = await buildAssetBundleFixture(root, editor)
  const before = await readFile(input)
  const data = join(root, 'data')
  const query = client(data)
  assert.ok(before.subarray(0, 8).equals(Buffer.from('UnityFS\0')))
  const inspection = await query('unity-bundle', input, '--inspect')
  assert.equal(inspection.status, 'completed', JSON.stringify(inspection))
  assert.equal(inspection.unityVersion, version)
  assert.equal(inspection.format, 8)
  assert.equal(inspection.total, 3)
  const texture = inspection.assets.find(asset => asset.classId === 28)
  assert.deepEqual([texture.status, texture.width, texture.height], ['available', 4, 4])
  const mesh = inspection.assets.find(asset => asset.format === 'glb')
  assert.deepEqual([mesh.status, mesh.vertices, mesh.triangles], ['available', 6, 2])
  assert.ok(inspection.assets.some(asset => asset.classId === 43 && asset.status === 'unsupported'))
  await assert.rejects(readdir(data), { code: 'ENOENT' })

  const output = await query('unity-bundle', input, '--fbx')
  assert.equal(output.converted, 2, JSON.stringify(output))
  assert.equal(output.skipped, 1)
  const manifest = JSON.parse(await readFile(join(output.output, 'manifest.json'), 'utf8'))
  assert.equal(manifest.source.sha256, createHash('sha256').update(before).digest('hex'))
  const entry = manifest.assets.find(asset => asset.format === 'png')
  assert.equal(entry.pathId, texture.pathId)
  const png = await readFile(join(output.output, entry.artifact.path))
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[25]], [4, 4, 6])
  assert.equal(png.subarray(37, 41).toString('ascii'), 'IDAT')
  const pixels = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))
  assert.deepEqual([...pixels.subarray(0, 9)], [0, 0, 96, 96, 255, 32, 96, 96, 255])
  assert.deepEqual([...pixels.subarray(51, 60)], [0, 0, 0, 96, 255, 32, 0, 96, 255])
  const { assets } = await query('search', 'Albedo', '--library', output.library.id)
  assert.equal(assets.length, 1)
  assert.equal(assets[0].ext, 'png')

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

  const alternate = join(root, 'Container.bin')
  await writeFile(alternate, before)
  const server = await startServer(root)
  try {
    const inspected = await server.post('/api/index/packages/inspect', { path: alternate })
    assert.equal(inspected.status, 200)
    const { package: plan } = await inspected.json()
    assert.deepEqual([plan.format, plan.containerVersion, plan.unityVersion, plan.hash], ['unityfs', 8, version, manifest.source.sha256])
    assert.equal(plan.assets.find(asset => asset.classId === 28).pathId, texture.pathId)
    const disallowed = await server.post('/api/index/packages/import', { path: alternate, hash: plan.hash, mode: 'engine-assisted' })
    assert.equal(disallowed.status, 400)

    const cached = await waitForImport(server, alternate, plan.hash, ['fbx'])
    assert.equal(cached.status, 'completed', cached.error)
    assert.equal(cached.result.reused, true)
    assert.equal(cached.result.library.id, output.library.id)
    assert.equal(cached.result.report.packageFormat, 'unityfs')
    assert.deepEqual(cached.result.report.counts, { converted: 2, unsupported: 1 })
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
})
