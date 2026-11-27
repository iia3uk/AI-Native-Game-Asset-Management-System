import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AssetIndex } from '../core/asset-index.mjs'
import { generateFixtures } from '../scripts/generate-fixtures.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0p8AAAAASUVORK5CYII=', 'base64')
const size = { width: 1, height: 1 }
const obj = [
  'mtllib materials/cloth.mtl', 'o UCX_Cloth', 'g Cloth_LOD1', 'v 0 0 0', 'v 4 0 0', 'v 4 2 3', 'v 0 2 3',
  'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1', 'usemtl Cloth', 'f -4/-4 -3/-3 -2/-2 -1/-1', '',
].join('\n')

function inspect(index, query) {
  return index.inspect(index.search({ q: query }).assets[0].id)
}

function embeddedGlb() {
  const document = {
    asset: { version: '2.0' }, buffers: [{ byteLength: png.length }],
    bufferViews: [{ buffer: 0, byteLength: png.length }],
    images: [{ bufferView: 0, mimeType: 'image/png' }, { bufferView: { toString: null, valueOf: null } }],
    textures: [{ source: 0 }],
  }
  const json = Buffer.from(JSON.stringify(document))
  const jsonPadding = (4 - json.length % 4) % 4
  const binPadding = (4 - png.length % 4) % 4
  const header = Buffer.alloc(20)
  header.write('glTF')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + json.length + jsonPadding + png.length + binPadding, 8)
  header.writeUInt32LE(json.length + jsonPadding, 12)
  header.write('JSON', 16)
  const bin = Buffer.alloc(8)
  bin.writeUInt32LE(png.length + binPadding)
  bin.write('BIN\0', 4)
  return Buffer.concat([header, json, Buffer.alloc(jsonPadding, 0x20), bin, png, Buffer.alloc(binPadding)])
}

test('OBJ analysis follows indexed MTL texture references as assets change', async t => {
  const root = await testDirectory(t)
  await mkdir(join(root, 'materials'))
  await mkdir(join(root, 'maps'))
  const material = join(root, 'materials', 'cloth.mtl')
  const texture = join(root, 'maps', 'cloth color.png')
  const model = join(root, 'cloth.obj')
  await writeFile(model, obj)
  await writeFile(material, 'newmtl Cloth\nmap_Kd -o 1 -s 1 1 1 "../maps/cloth color.png"\n')
  await writeFile(texture, png)
  const index = await AssetIndex.open(':memory:')
  try {
    const { id } = await index.connect(root)
    await index.scan(id)
    const first = inspect(index, 'cloth.obj')
    assert.deepEqual(first.analysis.metrics, {
      vertices: 4, triangles: 2, meshes: 1, materials: 1, hasUV: true, skins: 0, bones: 0, animations: 0,
      bounds: { min: [0, 0, 0], max: [4, 2, 3], size: [4, 2, 3], kind: 'authored-positions' },
      lod: true, collisionNamed: true, textures: 1,
    })
    const [mtl, tex] = first.analysis.dependencies
    assert.equal(mtl.status, 'available')
    assert.equal(mtl.targetId, inspect(index, 'cloth.mtl').asset.id)
    assert.deepEqual([tex.path, tex.status, tex.via, tex.dimensions], ['maps/cloth color.png', 'available', 'materials/cloth.mtl', size])
    await rm(texture)
    assert.equal((await index.scan(id)).reused, 2)
    assert.equal(index.inspect(first.asset.id).analysis.dependencies[1].status, 'unavailable')
    assert.equal(index.inspect(first.asset.id).analysis.dependencies[1].dimensions, null)
    await writeFile(material, 'not a material document\n')
    await index.scan(id)
    assert.ok(index.inspect(first.asset.id).analysis.issues.includes('invalid-material-library'))
    await mkdir(join(root, 'packages'))
    await rename(model, join(root, 'packages', 'cloth.obj'))
    assert.equal((await index.scan(id)).moved, 1)
    const moved = index.inspect(first.asset.id)
    assert.equal(moved.asset.path, 'packages/cloth.obj')
    assert.equal(moved.analysis.dependencies[0].path, 'packages/materials/cloth.mtl')
    assert.equal(moved.analysis.metrics.textures, null)
  } finally { await index.close() }
})

test('glTF analysis uses declared geometry and contains local, embedded and rejected references', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  await mkdir(join(root, 'models'), { recursive: true })
  await mkdir(join(root, 'images'))
  const aliasMode = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(directory, join(root, 'alias'), aliasMode)
  await writeFile(join(directory, 'private.png'), png)
  await writeFile(join(root, 'images', 'snow wood.png'), png)
  let requests = 0
  const server = createServer((_, response) => { requests++; response.end(png) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const geometry = Buffer.alloc(4 * 3 * 4)
  geometry.writeFloatLE(2, 12)
  geometry.writeFloatLE(3, 28)
  geometry.writeFloatLE(4, 44)
  await writeFile(join(root, 'models', 'base.bin'), geometry)
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ translation: [10, -1, 0], children: [1] }, { mesh: 0, scale: [2, 1, 1], name: 'LOD0' }],
    accessors: [{ type: 'VEC3', componentType: 5126, bufferView: 0, count: 4, min: [0, 0, 0], max: [2, 3, 4] }],
    bufferViews: [{ buffer: 0, byteLength: 48 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }, { attributes: { POSITION: 0 }, mode: 6 }] }],
    buffers: [{ uri: 'base.bin', byteLength: 48 }],
    images: [
      { uri: '../images/snow%20wood.png' }, { uri: 'data:image/png;base64,' + png.toString('base64') },
      { uri: 'http://127.0.0.1:' + server.address().port + '/private.png' },
      { uri: '%2E%2E/%2E%2E/private.png' }, { uri: '../alias/private.png' },
      { uri: 'file:///private.png' }, { uri: '../images/unknown.format' },
    ],
    textures: [{ source: 0 }, { source: 1 }],
  }
  await writeFile(join(root, 'models', 'source.gltf'), JSON.stringify(document))
  const index = await AssetIndex.open(':memory:')
  try {
    const { id } = await index.connect(root)
    await index.scan(id)
    const { analysis } = inspect(index, 'source.gltf')
    assert.equal(analysis.status, 'analyzed')
    assert.deepEqual([analysis.metrics.vertices, analysis.metrics.triangles, analysis.metrics.textures, analysis.metrics.lod], [4, 4, 2, true])
    assert.deepEqual(analysis.metrics.bounds, {
      min: [10, -1, 0], max: [14, 2, 4], size: [4, 3, 4], kind: 'scene-aabb',
    })
    assert.deepEqual(analysis.dependencies.map(item => item.status),
      ['available', 'available', 'embedded', 'external', 'outside', 'unavailable', 'outside', 'unindexed'])
    assert.deepEqual(analysis.dependencies.slice(1, 3).map(item => item.dimensions), [size, size])
    assert.equal(analysis.dependencies[4].path, null)
    assert.ok(!JSON.stringify(analysis).includes('127.0.0.1'))
    assert.equal(requests, 0)
  } finally { await index.close() }
})

test('GLB technical reports are available over HTTP after a regular fixture scan', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  await generateFixtures(root, { includeErrors: true })
  await writeFile(join(root, 'embedded-image.glb'), embeddedGlb())
  const server = await startServer(directory)
  try {
    const connection = await server.post('/api/index/libraries', { path: root })
    const { library } = await connection.json()
    const scanned = await server.post('/api/index/libraries/' + library.id + '/scan', {})
    assert.equal(scanned.status, 200)
    const read = async query => {
      const { assets: [asset] } = await server.request('/api/index/search?q=' + query).then(result => result.json())
      return server.request('/api/index/assets/' + asset.id).then(result => result.json())
    }
    const { analysis } = await read('woodland-cabin.glb')
    assert.equal(analysis.metrics.triangles, 252)
    assert.equal(analysis.metrics.animations, 1)
    assert.equal(analysis.metrics.hasUV, true)
    assert.ok(analysis.metrics.bounds.size.every(value => value > 0))
    assert.equal(analysis.dependencies[0].status, 'embedded')
    const embedded = (await read('embedded-image.glb')).analysis.dependencies
    assert.deepEqual(embedded.map(item => item.status), ['embedded', 'embedded', 'unresolved'])
    assert.deepEqual(embedded[1].dimensions, size)
    assert.equal((await read('damaged.glb')).analysis.status, 'invalid')
    const broken = (await read('missing-texture.obj')).analysis
    assert.equal(broken.dependencies[1].status, 'unavailable')
    assert.equal(broken.dependencies[1].path, 'Test cases/absent.png')
  } finally { await server.close() }
})

test('schema 3 migration backfills analysis on scan without changing asset history or reprocessing static files', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  const database = join(directory, 'index.sqlite')
  await mkdir(root)
  await writeFile(join(root, 'first.obj'), 'v 0 0 0\n')
  const old = await AssetIndex.open(database)
  const { id } = await old.connect(root)
  await old.scan(id)
  const { asset } = inspect(old, 'first.obj')
  old.updateAsset(asset.id, { note: 'Keep the review' })
  await old.close()
  const raw = new DatabaseSync(database)
  let index
  try {
    raw.exec('DROP TABLE quality_profiles; DROP TABLE asset_dependencies; DROP TABLE asset_analysis; PRAGMA user_version = 3')
    index = await AssetIndex.open(database)
    assert.equal(index.inspect(asset.id).analysis.status, 'pending')
    const { changed, reused } = await index.scan(id)
    assert.deepEqual([changed, reused], [0, 1])
    assert.equal(index.inspect(asset.id).analysis.metrics.vertices, 1)
    assert.equal(index.inspect(asset.id).versions.length, 1)
    assert.equal(index.inspect(asset.id).asset.note, 'Keep the review')
    raw.exec("CREATE TRIGGER unchanged_analysis BEFORE DELETE ON asset_analysis BEGIN SELECT RAISE(ABORT, 'unexpected reprocessing'); END")
    assert.equal((await index.scan(id)).reused, 1)
  } finally {
    await index?.close()
    raw.close()
  }
})
