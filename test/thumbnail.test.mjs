import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AssetIndex } from '../core/asset-index.mjs'
import { ThumbnailCache } from '../core/thumbnail-cache.mjs'
import { generateFixtures } from '../scripts/generate-fixtures.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const signature = Buffer.from('89504e470d0a1a0a', 'hex')
const binary = coords => {
  const data = Buffer.alloc(36)
  coords.flat().forEach((value, i) => data.writeFloatLE(value, i * 4))
  return data
}
const gltf = uri => JSON.stringify({
  asset: { version: '2.0' },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, .5, .2, 1], baseColorTexture: { index: 0 } } }],
  images: [{ uri: 'https://example.invalid/texture.png' }], textures: [{ source: 0 }],
  buffers: [{ uri, byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 2, 1] }],
})

function assertThumbnail(data) {
  assert.ok(data.subarray(0, 8).equals(signature))
  assert.equal(data.readUInt32BE(16), 160)
  assert.equal(data.readUInt32BE(20), 160)
  assert.equal(data.toString('ascii', 37, 41), 'IDAT')
  const pixels = inflateSync(data.subarray(41, 41 + data.readUInt32BE(33)))
  assert.equal(pixels.length, 160 * (160 * 3 + 1))
  assert.ok(pixels.some(value => value > 100), 'the model must be visible over the dark background')
}

async function waitForJob(server, job) {
  const deadline = Date.now() + 8000
  while (['pending', 'running'].includes(job.status) && Date.now() < deadline) {
    await delay(50)
    ;({ job } = await (await server.request('/api/index/jobs/' + job.id)).json())
  }
  return job
}

test('HTTP renders a GLB, OBJ and external-buffer glTF, and rejects stale output and external buffers', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  await generateFixtures(root)
  const gltfPath = join(root, 'triangle.gltf')
  const binPath = join(root, 'mesh.bin')
  await writeFile(gltfPath, gltf('mesh.bin'))
  await writeFile(binPath, binary([[0, 0, 0], [2, 0, 0], [.1, 1, 0]]))
  await writeFile(join(directory, 'outside.bin'), binary([[0, 0, 0], [1, 0, 0], [0, 1, 0]]))
  await writeFile(join(root, 'outside.gltf'), gltf('../outside.bin'))
  const server = await startServer(directory)
  try {
    const { library } = await (await server.post('/api/index/libraries', { path: root })).json()
    const scan = () => server.post('/api/index/libraries/' + library.id + '/scan', {})
    assert.equal((await scan()).status, 200)
    const { assets } = await (await server.request('/api/index/search')).json()
    const endpoint = name => '/api/index/assets/' + assets.find(asset => asset.name === name).id + '/thumbnail'
    async function render(name) {
      const url = endpoint(name)
      const pending = await server.post(url, {})
      assert.equal(pending.status, 202)
      const job = await waitForJob(server, (await pending.json()).job)
      assert.equal(job.status, 'completed', job.error)
      assert.equal(job.progress, 100)
      const preview = await (await server.request(url)).json()
      assert.equal(preview.status, 'available')
      assert.equal(preview.path, undefined)
      const response = await server.request(preview.url)
      assert.equal(response.headers.get('Content-Type'), 'image/png')
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
      const image = Buffer.from(await response.arrayBuffer())
      assertThumbnail(image)
      return { preview, image }
    }
    await render('woodland-cabin.glb')
    await render('pennant.obj')
    const original = await render('triangle.gltf')
    const cached = await server.post(endpoint('triangle.gltf'), {})
    assert.equal(cached.status, 200)
    assert.equal((await cached.json()).url, original.preview.url)
    const scanJobs = await (await server.request('/api/index/jobs?type=scan')).json()
    assert.equal(scanJobs.jobs.length, 1)
    assert.equal(scanJobs.jobs[0].type, 'scan')
    const usage = await (await server.request('/api/index/thumbnail-cache')).json()
    assert.equal(usage.entries, 3)
    assert.ok(usage.bytes > 0 && usage.bytes <= usage.limit)
    const changed = binary([[0, 0, 0], [2, 0, 0], [1.9, 2, 1]])
    await writeFile(binPath, changed)
    assert.equal((await (await server.request(endpoint('triangle.gltf'))).json()).status, 'stale')
    assert.equal((await server.request(original.preview.url)).status, 404)
    assert.equal((await scan()).status, 200)
    const updated = await render('triangle.gltf')
    assert.notEqual(updated.preview.url, original.preview.url)
    assert.notDeepEqual(updated.image, original.image)
    assert.equal((await server.request(original.preview.url)).status, 404)
    assert.equal((await (await server.post(endpoint('outside.gltf'), {})).json()).status, 'unavailable')
    assert.equal((await server.post('/api/index/thumbnail-cache/clear', {}, { Origin: 'http://example.invalid' })).status, 403)
    const cleared = await (await server.post('/api/index/thumbnail-cache/clear', {})).json()
    assert.equal(cleared.entries, 0)
    assert.equal((await server.request(updated.preview.url)).status, 404)
    assert.equal(await readFile(gltfPath, 'utf8'), gltf('mesh.bin'))
    assert.deepEqual(await readFile(binPath), changed)
  } finally {
    await server.close()
  }
})

test('thumbnail leases and duplicate submissions are shared across connections', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  const database = join(directory, 'data', 'index.sqlite')
  await generateFixtures(root)
  const index = await AssetIndex.open(database)
  const second = await AssetIndex.open(database)
  const raw = new DatabaseSync(database)
  try {
    const { id } = await index.connect(root)
    await index.scan(id)
    const { assets: [first, next] } = index.search({ kind: 'model' })
    const plan = index.thumbnailSource(first.id)
    const a = index.jobs.enqueueThumbnail(plan)
    assert.equal(second.jobs.enqueueThumbnail(second.thumbnailSource(first.id)).id, a.id)
    const b = second.jobs.enqueueThumbnail(second.thumbnailSource(next.id))
    const scan = index.jobs.enqueue(id)
    assert.equal(index.jobs.claim('preview-worker', 'thumbnail').id, a.id)
    assert.equal(second.jobs.claim('other-preview-worker', 'thumbnail'), null)
    assert.equal(second.jobs.claim('scan-worker').id, scan.id)
    raw.prepare('UPDATE processing_jobs SET lease_until = 0 WHERE id = ?').run(a.id)
    assert.equal(second.jobs.claim('other-preview-worker', 'thumbnail').id, b.id)
    assert.equal(index.jobs.get(a.id).status, 'interrupted')
    assert.equal(index.jobs.retry(a.id).status, 'pending')
    assert.equal(index.jobs.cancel(a.id).status, 'cancelled')
    assert.equal(second.jobs.get(b.id).status, 'running')
    index.disconnect(id)
    assert.equal(second.jobs.get(b.id).cancelRequested, true)
    assert.throws(() => second.jobs.completeThumbnail(b.id, 'other-preview-worker', () => assert.fail('cancelled output published')),
      /отменена/)
    assert.equal(index.thumbnailSource(first.id), null)
  } finally {
    raw.close()
    await second.close()
    await index.close()
  }
})

test('schema 5 scan records survive migration and a queued thumbnail resumes after restart', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  const database = join(directory, 'data', 'index.sqlite')
  await generateFixtures(root)
  let index = await AssetIndex.open(database)
  const { id } = await index.connect(root)
  await index.scan(id)
  const scan = index.jobs.enqueue(id)
  const { assets: [model] } = index.search({ q: 'woodland-cabin' })
  index.updateAsset(model.id, { note: 'Keep reviewed model' })
  await index.close()
  const raw = new DatabaseSync(database)
  try {
    raw.exec(`CREATE TABLE schema5_jobs AS SELECT id, library_id, type, status, priority, created_at, started_at,
      finished_at, attempts, progress, result, error, worker, lease_until, cancel_requested, trigger FROM processing_jobs;
      DROP TABLE processing_jobs;
      ALTER TABLE schema5_jobs RENAME TO processing_jobs;
      PRAGMA user_version = 5;`)
  } finally { raw.close() }
  index = await AssetIndex.open(database)
  let queued
  try {
    assert.equal(index.integrity().schemaVersion, 6)
    assert.equal(index.jobs.get(scan.id).createdAt, scan.createdAt)
    assert.equal(index.asset(model.id).note, 'Keep reviewed model')
    queued = index.jobs.enqueueThumbnail(index.thumbnailSource(model.id))
  } finally { await index.close() }
  const server = await startServer(directory)
  try {
    assert.equal((await waitForJob(server, scan)).status, 'completed')
    const finished = await waitForJob(server, queued)
    assert.equal(finished.status, 'completed', finished.error)
    const preview = await (await server.request('/api/index/assets/' + model.id + '/thumbnail')).json()
    assertThumbnail(Buffer.from(await (await server.request(preview.url)).arrayBuffer()))
  } finally { await server.close() }
})

test('thumbnail cache evicts by use and expires old entries without touching other files', async t => {
  const workspace = await testDirectory(t)
  const directory = join(workspace, 'cache')
  await mkdir(directory)
  const cache = new ThumbnailCache(directory, 128 * 1024)
  const image = Buffer.alloc(60_000)
  signature.copy(image)
  const [a, b, c, old] = ['a', 'b', 'c', 'd'].map(value => value.repeat(64))
  await writeFile(join(directory, 'other.png'), 'preserved')
  await cache.put(a, image)
  await cache.put(b, image)
  const alias = join(workspace, 'configured-cache')
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(await new ThumbnailCache(alias).read(a, { touch: false }), image)
  const yesterday = new Date(Date.now() - 86_400_000)
  await utimes((await cache.get(a)).path, yesterday, yesterday)
  await utimes((await cache.get(b)).path, yesterday, yesterday)
  assert.deepEqual(await cache.read(a), image)
  await cache.put(c, image)
  assert.equal(await cache.get(b), null)
  assert.ok(await cache.get(a))
  await cache.put(old, image)
  const expired = new Date(Date.now() - 31 * 86_400_000)
  await utimes((await cache.get(old)).path, expired, expired)
  assert.equal(await cache.get(old), null)
  await cache.put(c, image)
  assert.equal((await cache.usage()).bytes, 60_000)
  assert.deepEqual(await cache.clear(), { entries: 0, bytes: 0, limit: 128 * 1024 })
  assert.equal(await readFile(join(directory, 'other.png'), 'utf8'), 'preserved')
})
