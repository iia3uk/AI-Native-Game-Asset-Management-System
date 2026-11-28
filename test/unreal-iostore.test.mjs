import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { scanPackageFolder } from '../core/packages/folder.mjs'
import { ioStoreResult } from '../core/engines/unreal/decoder/protocol.mjs'
import { locateUnrealDecoder, runUnrealDecoder } from '../core/engines/unreal/decoder/run.mjs'
import { processIoStore } from '../core/packages/unreal/iostore/import.mjs'
import { readFbxGeometry } from './fixtures/blender-model.mjs'
import { makeIoStore, writeIoStoreFixture } from './fixtures/unreal-iostore.mjs'
import { zenCollisionFixture } from './fixtures/unreal-zen-collision.mjs'
import { zenMaterialFixture } from './fixtures/unreal-zen-material.mjs'
import { assertZenPng } from './fixtures/unreal-zen-texture.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const run = promisify(execFile)
const withDecoder = { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 45_000 }

async function waitForJob(server, id) {
  const deadline = Date.now() + 12_000
  do {
    const response = await server.request('/api/index/jobs/' + id)
    assert.equal(response.status, 200)
    const { job } = await response.json()
    if (!['pending', 'running'].includes(job.status)) return job
    await setTimeout(100)
  } while (Date.now() < deadline)
  assert.fail('IoStore job did not reach a terminal state.')
}

test('folder discovery uses IoStore TOCs and rejects incomplete or encrypted sets before starting a worker', async t => {
  const root = await testDirectory(t)
  const fixture = await writeIoStoreFixture(root, 'Target')
  const forged = join(root, 'Forged.utoc')
  await writeFile(forged, Buffer.alloc(144))
  const { packages } = await scanPackageFolder(root, { structured: true })
  assert.deepEqual(packages, [{ format: 'unreal-iostore', path: 'Target.utoc' }])
  await rm(fixture.partitionPaths[1])
  const inspect = path => processIoStore({ root, path }, { inspectOnly: true })
  assert.equal((await inspect(fixture.path)).issue, 'unreal-iostore-companion-missing')
  await writeFile(fixture.path, makeIoStore({ flags: 11 }).toc)
  assert.equal((await inspect(fixture.path)).issue, 'unreal-iostore-encrypted')
  await writeFile(fixture.path, makeIoStore({ flags: 13 }).toc)
  assert.equal((await inspect(fixture.path)).issue, 'unreal-iostore-signed')
  assert.equal((await inspect(join(root, 'Missing.ucas'))).issue, 'unreal-iostore-toc-missing')
  assert.equal((await inspect(forged)).issue, 'unreal-iostore-layout')
})

test('IoStore imports a partitioned container through the shared queue and indexes and exports its resources',
  withDecoder, async t => {
    const root = await testDirectory(t)
    const incoming = join(root, 'incoming')
    const destination = join(root, 'export')
    const data = join(root, 'cli-data')
    await Promise.all([mkdir(incoming), mkdir(destination)])
    const fixture = await writeIoStoreFixture(incoming, 'Content')
    const { path, partitionPaths, data: parts, payloads } = fixture
    const query = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args, '--json'],
      { env: { ...process.env, ASSET_VIEWER_DATA_DIR: data }, windowsHide: true })).stdout)
    const plan = await query('unreal-extract', partitionPaths[1], '--inspect')
    assert.deepEqual([plan.containerVersion, plan.partitions, plan.chunks, plan.total], [8, 2, 3, 3])
    assert.deepEqual(plan.files.map(file => file.name), ['Content.utoc', 'Content.ucas', 'Content_s1.ucas'])
    assert.deepEqual(plan.entries.map(entry => entry.chunkId),
      ['010000000000000000000007', '020000000000000000000001', '020000000000000000000002'])
    const folder = await query('package-folder', incoming, '--import')
    assert.deepEqual(folder.packages, [{ format: 'unreal-iostore', path: 'Content.utoc' }])
    assert.equal(folder.results[0].job.status, 'completed')
    assert.equal(folder.results[0].scan.status, 'completed')
    const server = await startServer(root)
    try {
      const inspect = async path => {
        const response = await server.post('/api/index/packages/inspect', { path })
        assert.equal(response.status, 200)
        return (await response.json()).package
      }
      const queued = async () => {
        const response = await server.post('/api/index/packages/import', { path: partitionPaths[1], hash: plan.hash })
        assert.equal(response.status, 202)
        return waitForJob(server, (await response.json()).job.id)
      }
      assert.equal((await inspect(path)).hash, plan.hash)
      const job = await queued()
      assert.equal(job.status, 'completed', job.error)
      const { directory, library, scanJobId, report } = job.result
      assert.equal(report.packageFormat, 'unreal-iostore')
      assert.deepEqual(report.extractedTypes, { package: 1, bulk: 1, file: 1, registry: 0 })
      assert.equal((await waitForJob(server, scanJobId)).status, 'completed')
      const route = '/api/index/jobs/' + job.id
      const { assets: entries } = await (await server.request(route + '/manifest')).json()
      const [sound, asset, bulk] = ['file', 'package', 'bulk'].map(kind => entries.find(row => row.kind === kind))
      assert.deepEqual(await readFile(join(directory, sound.artifact.path)), payloads.audio)
      assert.deepEqual(await readFile(join(directory, asset.artifact.path)), payloads.asset)
      assert.deepEqual(await readFile(join(directory, bulk.artifact.path)), payloads.bulk)
      const { assets } = await (await server.request('/api/index/search?library=' + library.id)).json()
      assert.deepEqual(assets.map(row => row.name).sort(), ['IoStore-Tone.wav', 'Sample.uasset'])
      const ordinal = entries.indexOf(asset)
      const exportPlan = await (await server.post(route + '/export-plan', { destination, asset: ordinal })).json()
      const publication = await server.post(route + '/export', { destination, asset: ordinal, key: exportPlan.key })
      assert.equal(publication.status, 201)
      const exported = (await publication.json()).directory
      assert.deepEqual(await readFile(join(exported, asset.artifact.path)), payloads.asset)
      assert.deepEqual(await readFile(join(exported, bulk.artifact.path)), payloads.bulk)
      assert.equal((await queued()).result.reused, true)

      const changed = Buffer.from(parts[1])
      changed[0] ^= 1
      await writeFile(partitionPaths[1], changed)
      assert.notEqual((await inspect(path)).hash, plan.hash)
      assert.match((await queued()).error, /изменилась после анализа/)
      await writeFile(partitionPaths[1], parts[1])
      await writeFile(join(directory, sound.artifact.path), Buffer.alloc(payloads.audio.length))
      assert.match((await queued()).error, /Кеш импорта Unreal IoStore повреждён/)
      assert.deepEqual(await readFile(path), fixture.toc)
      assert.deepEqual(await readFile(partitionPaths[0]), parts[0])
      assert.deepEqual(await readFile(partitionPaths[1]), parts[1])
    } finally { await server.close() }
  })

test('Zen textures keep the native asset and publish pixel-exact indexed PNGs with verified cache and export',
  withDecoder, async t => {
    const root = await testDirectory(t)
    const incoming = join(root, 'incoming')
    const destination = join(root, 'export')
    await Promise.all([mkdir(incoming), mkdir(destination)])
    const server = await startServer(root)
    try {
      for (const mode of ['inline', 'external', 'broken']) {
        const fixture = await writeIoStoreFixture(incoming, mode, { texture: mode })
        const inspected = await server.post('/api/index/packages/inspect', { path: fixture.path })
        assert.equal(inspected.status, 200)
        const { package: { hash } } = await inspected.json()
        const queued = async () => {
          const response = await server.post('/api/index/packages/import', { path: fixture.path, hash })
          assert.equal(response.status, 202)
          return waitForJob(server, (await response.json()).job.id)
        }
        const job = await queued()
        assert.equal(job.status, 'completed', job.error)
        const route = '/api/index/jobs/' + job.id
        const { directory, library, scanJobId, report } = job.result
        const converted = Number(mode !== 'broken')
        assert.deepEqual(report.textures, { converted, skipped: 1 - converted, failed: 0 })
        assert.equal((await waitForJob(server, scanJobId)).status, 'completed')
        const { assets: entries } = await (await server.request(route + '/manifest')).json()
        const [asset, bulk] = ['package', 'bulk'].map(kind => entries.find(row => row.kind === kind))
        assert.deepEqual(await readFile(join(directory, asset.artifact.path)), fixture.payloads.asset)
        assert.deepEqual(await readFile(join(directory, bulk.artifact.path)), fixture.payloads.bulk)
        const [texture] = asset.exports
        assert.equal(texture.method, 'cue4parse-iostore-zen-texture')
        const { assets } = await (await server.request('/api/index/search?library=' + library.id)).json()
        assert.equal(assets.some(row => row.name === 'Sample.png'), Boolean(converted))
        assert.equal((await queued()).result.reused, true)
        if (!converted) {
          assert.equal(texture.issue, 'unreal-iostore-texture-bulk-range')
          assert.equal(texture.path, undefined)
          continue
        }
        const srgb = mode === 'inline'
        assert.deepEqual([texture.width, texture.height, texture.mip, texture.srgb], [2, 2, 0, srgb])
        assert.equal(texture.from, asset.artifact.path)
        const image = await readFile(join(directory, texture.path))
        assertZenPng(image, srgb)
        const ordinal = entries.indexOf(asset)
        const plan = await (await server.post(route + '/export-plan', { destination, asset: ordinal })).json()
        const publication = await server.post(route + '/export', { destination, asset: ordinal, key: plan.key })
        assert.equal(publication.status, 201)
        const exported = (await publication.json()).directory
        assert.deepEqual(await readFile(join(exported, texture.path)), image)
        assert.deepEqual(await readFile(join(exported, bulk.artifact.path)), fixture.payloads.bulk)
        const tampered = Buffer.from(image)
        tampered[41] ^= 1
        await writeFile(join(directory, texture.path), tampered)
        assert.match((await queued()).error, /Кеш импорта Unreal IoStore повреждён/)
      }
    } finally { await server.close() }
  })

test('IoStore worker results only allow numbered texture outputs on extracted Zen assets', () => {
  const options = { inspectOnly: false, version: 8, chunks: 1, partitions: 2 }
  const entry = { path: 'Sample.uasset', size: 440, status: 'extracted', issue: null, output: 0,
    chunkId: '9d2fbb016ac3df0c00000001', kind: 'package',
    texture: { width: 2, height: 2, size: 94, mip: 0, pixelFormat: 'PF_B8G8R8A8', srgb: true, normalZReconstructed: false } }
  const result = { protocol: 1, status: 'completed', containerVersion: 8, chunks: 1, partitions: 2,
    textureDecoder: 2, audioDecoder: 1, meshDecoder: 1, materialDecoder: 1, collisionDecoder: 1, entries: [entry] }
  assert.equal(ioStoreResult(result, options).entries[0].texture.file, '00000.png')
  assert.equal(ioStoreResult({ ...result, textureDecoder: undefined }, options), null)
  assert.equal(ioStoreResult({ ...result, entries: [{ ...entry, path: 'Sample.umap' }] }, options), null)
  assert.equal(ioStoreResult({ ...result, entries: [{ ...entry, textureIssue: 'unreal-iostore-texture-limit' }] }, options), null)
})

test('IoStore mesh output uses numbered files and cannot claim a material or another derivative', () => {
  const section = { slot: 0, firstIndex: 0, triangles: 1, name: 'Paint', material: null, collision: true }
  const lod = { lod: 0, vertices: 3, indices: 3, uvs: 1, colors: false, size: 156,
    tangentsQuantized: false, sections: [section], file: '../outside.mesh' }
  const mesh = { lods: [lod], missing: [1] }
  const entry = { path: 'Sample.uasset', size: 440, status: 'extracted', issue: null, output: 0,
    chunkId: '9d2fbb016ac3df0c00000001', kind: 'package', mesh }
  const options = { inspectOnly: false, version: 8, chunks: 1, partitions: 2 }
  const check = (value, settings = options) => ioStoreResult({ protocol: 1, status: 'completed', containerVersion: 8,
    chunks: 1, partitions: 2, textureDecoder: 2, audioDecoder: 1, meshDecoder: 1, materialDecoder: 1,
    collisionDecoder: 1, entries: [value] }, settings)
  assert.equal(check(entry).entries[0].mesh.lods[0].file, '00000-0.mesh')
  assert.equal(check({ ...entry, audioIssue: 'unreal-iostore-audio-layout' }), null)
  assert.equal(check({ ...entry, mesh: { ...mesh, missing: [0] } }), null)
  const foreign = { ...lod, sections: [{ ...section, material: '/Game/Foreign' }] }
  assert.equal(check({ ...entry, mesh: { ...mesh, lods: [foreign] } }), null)
  assert.equal(check({ ...entry, output: null, status: 'available' }, { ...options, inspectOnly: true }), null)
  const collision = { body: 'BodySetup', buildScale: [1, 1, 1], omitted: [],
    shapes: [{ type: 'sphere', center: [0, 0, 0], radius: 1, restOffset: 0 }] }
  assert.deepEqual(check({ ...entry, collision }).entries[0].collision, collision)
  assert.equal(check({ ...entry, mesh: undefined, collision }), null)
  assert.equal(check({ ...entry, collision, collisionIssue: 'unreal-iostore-collision-layout' }), null)
  assert.equal(check({ ...entry, collision: { ...collision, buildScale: [1, 1, Infinity] } }), null)
})

test('UE5.3 and 5.4 IoStore imports index and export verified collision independently of render LODs', withDecoder, async t => {
  const root = await testDirectory(t)
  const destination = join(root, 'export')
  await mkdir(destination)
  const server = await startServer(root)
  try {
    for (const mode of ['ue53', 'ue54', 'bad-shape', 'wrong-owner', 'wrong-class', 'overlap', 'no-render']) {
      const fixture = await writeIoStoreFixture(root, mode, zenCollisionFixture(mode))
      const inspected = await server.post('/api/index/packages/inspect', { path: fixture.path })
      assert.equal(inspected.status, 200)
      const { package: { hash } } = await inspected.json()
      const queue = async () => {
        const response = await server.post('/api/index/packages/import', { path: fixture.path, hash })
        const body = await response.json()
        assert.equal(response.status, 202, JSON.stringify(body))
        return waitForJob(server, body.job.id)
      }
      const job = await queue()
      assert.equal(job.status, 'completed', job.error)
      const { directory, library, scanJobId, report } = job.result
      assert.equal((await waitForJob(server, scanJobId)).status, 'completed')
      const route = '/api/index/jobs/' + job.id
      const { assets } = await (await server.request(route + '/manifest')).json()
      const asset = assets.find(row => row.kind === 'package')
      const { collision } = report.meshes
      if (mode.startsWith('wrong') || mode === 'overlap') {
        assert.deepEqual(collision, { assets: 0, shapes: 0, glb: 0, incomplete: 1 }, mode)
        assert.equal(asset.collisionIssue, 'unreal-iostore-collision-layout', mode)
        assert.equal(report.meshes.gltf, 2)
        assert.ok(asset.exports.every(row => !row.role.startsWith('collision-')))
        continue
      }
      const partial = mode === 'bad-shape'
      assert.deepEqual(collision, { assets: 1, shapes: partial ? 3 : 4, glb: 1, incomplete: Number(partial) }, mode)
      assert.equal(report.meshes.gltf, mode === 'no-render' ? 0 : 2)
      const description = asset.exports.find(row => row.role === 'collision-shapes')
      const preview = asset.exports.find(row => row.role === 'collision-preview')
      const metadata = JSON.parse(await readFile(join(directory, description.path), 'utf8'))
      assert.equal(preview.settingsPath, description.path)
      assert.equal(metadata.body, 'BodySetup')
      assert.equal(metadata.traceMode, 'CTF_UseSimpleAndComplex')
      assert.equal(metadata.doubleSided, true)
      assert.equal(metadata.lengthUnit, 'cm')
      assert.deepEqual(metadata.shapes.map(row => row.type), partial ? ['box', 'sphere', 'capsule'] : ['box', 'sphere', 'capsule', 'convex'])
      assert.deepEqual(metadata.shapes[0].center, [75.125, -25, 0])
      assert.deepEqual(metadata.shapes[0].dimensions, [100, 40, 30])
      assert.equal(metadata.shapes[0].contributesToMass, false)
      assert.equal(metadata.shapes[0].collisionEnabled, 'ECollisionEnabled::QueryAndPhysics')
      assert.equal(metadata.shapes[1].radius, 25.5)
      assert.equal(metadata.shapes[2].length, 90)
      if (partial) {
        assert.deepEqual(metadata.omitted, [{ field: 'ConvexElems', index: 0 }])
        assert.equal(asset.collisionIssue, 'unreal-iostore-collision-partial')
      } else {
        const hull = metadata.shapes.at(-1)
        assert.equal(hull.indexSource, mode === 'ue53' ? undefined : 'convex-hull')
        assert.equal(hull.indices.length, 12)
        assert.deepEqual(hull.transform, { rotation: [0, 0, 0, 1], translation: [200, 300, 0], scale: [1, 2, 1] })
      }
      const bytes = await readFile(join(directory, preview.path))
      const scene = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)))
      assert.deepEqual(scene.nodes.map(node => node.extras.collisionShape), metadata.shapes.map(shape => shape.type))
      const { assets: indexed } = await (await server.request('/api/index/search?kind=model&library=' + library.id)).json()
      assert.ok(indexed.some(row => row.path === preview.path))
      if (mode !== 'ue54') continue
      assert.equal((await queue()).result.reused, true)
      const ordinal = assets.indexOf(asset)
      const plan = await (await server.post(route + '/export-plan', { destination, asset: ordinal })).json()
      const published = await server.post(route + '/export', { destination, asset: ordinal, key: plan.key })
      assert.equal(published.status, 201)
      const delivery = (await published.json()).directory
      assert.deepEqual(await readFile(join(delivery, preview.path)), bytes)
      assert.deepEqual(JSON.parse(await readFile(join(delivery, description.path), 'utf8')), metadata)
      assert.deepEqual(await readFile(join(delivery, asset.artifact.path)), fixture.payloads.asset)
      await writeFile(join(directory, preview.path), Buffer.alloc(bytes.length))
      assert.match((await queue()).error, /Кеш импорта Unreal IoStore повреждён/)
      assert.deepEqual(await readFile(fixture.path), fixture.toc)
    }
  } finally { await server.close() }
})

test('versioned UE 5.3 and 5.4 static mesh LODs enter the IoStore library with exact bulk pairing and verified exports',
  { ...withDecoder, timeout: 60_000 }, async t => {
    const root = await testDirectory(t)
    const destination = join(root, 'export')
    await mkdir(destination)
    const server = await startServer(root)
    try {
      for (const [name, mode, bulkName] of [['UE53', 'ue53'], ['UE54', 'ue54'],
        ['Broken', 'broken'], ['ForeignStem', 'ue54', 'Other.ubulk']]) {
        const fixture = await writeIoStoreFixture(root, name, { staticMesh: mode, bulkName })
        const partial = name === 'Broken' || name === 'ForeignStem'
        const lods = partial ? 1 : 2
        const withFbx = name === 'UE54' && process.env.ASSET_VIEWER_TEST_NATIVE_BLENDER === '1'
        const inspected = await server.post('/api/index/packages/inspect', { path: fixture.path })
        assert.equal(inspected.status, 200)
        const { package: { hash } } = await inspected.json()
        const queue = async () => {
          const response = await server.post('/api/index/packages/import', {
            path: fixture.path, hash, formats: withFbx ? ['fbx', 'glb'] : ['glb'],
          })
          const body = await response.json()
          assert.equal(response.status, 202, JSON.stringify(body))
          return waitForJob(server, body.job.id)
        }
        const job = await queue()
        assert.equal(job.status, 'completed', job.error)
        const { directory, library, scanJobId, report } = job.result
        assert.deepEqual(report.meshes, { meshes: 1, gltf: lods, missingLods: Number(partial), skipped: 0, failed: 0,
          derivatives: { fbx: withFbx ? lods : 0, glb: lods } })
        assert.equal((await waitForJob(server, scanJobId)).status, 'completed')
        const route = '/api/index/jobs/' + job.id
        const { assets: entries } = await (await server.request(route + '/manifest')).json()
        const asset = entries.find(row => row.kind === 'package')
        const bulk = entries.find(row => row.kind === 'bulk')
        assert.equal(asset.missingLods?.[0], partial ? 1 : undefined)
        const previews = asset.exports.filter(product => product.format === 'glb')
        assert.deepEqual(previews.map(product => [product.lod, product.metrics.triangles]),
          partial ? [[0, 2]] : [[0, 2], [1, 1]])
        const model = await readFile(join(directory, previews[0].path))
        assert.equal(model.toString('ascii', 0, 4), 'glTF')
        const json = JSON.parse(model.toString('utf8', 20, 20 + model.readUInt32LE(12)))
        assert.deepEqual(json.materials.map(item => [item.name, item.extras.unrealMaterialSlot]), [['Trim', 1], ['Paint', 0]])
        const [primitive] = json.meshes[0].primitives
        assert.ok(['TEXCOORD_1', 'COLOR_0', 'TANGENT', 'NORMAL'].every(field => Number.isInteger(primitive.attributes[field])))
        const { assets: indexed } = await (await server.request('/api/index/search?kind=model&library=' + library.id)).json()
        assert.ok(previews.every(product => indexed.some(row => row.path === product.path)))
        if (withFbx) {
          const paths = asset.exports.filter(product => product.format === 'fbx').map(product => join(directory, product.path))
          assert.deepEqual(await readFbxGeometry(paths), [[2, 2, 1, 2], [1, 2, 1, 1]])
        }
        assert.equal((await queue()).result.reused, true)
        if (name !== 'UE54') continue
        const ordinal = entries.indexOf(asset)
        const plan = await (await server.post(route + '/export-plan', { destination, asset: ordinal })).json()
        const publication = await server.post(route + '/export', { destination, asset: ordinal, key: plan.key })
        assert.equal(publication.status, 201)
        const delivery = (await publication.json()).directory
        assert.deepEqual(await readFile(join(delivery, previews[0].path)), model)
        assert.deepEqual(await readFile(join(delivery, bulk.artifact.path)), fixture.payloads.bulk)
        const buffer = asset.exports.find(product => product.role === 'model-buffer')
        await writeFile(join(directory, buffer.path), Buffer.alloc(buffer.size))
        assert.match((await queue()).error, /Кеш импорта Unreal IoStore повреждён/)
        assert.deepEqual(await readFile(fixture.path), fixture.toc)
      }
    } finally { await server.close() }
  })

test('IoStore reports a space-limited static mesh separately from permanently missing geometry', withDecoder, async t => {
  const root = await testDirectory(t)
  const fixture = await writeIoStoreFixture(root, 'input', { staticMesh: 'ue54' })
  const rawBytes = Object.values(fixture.payloads).reduce((size, bytes) => size + bytes.length, 0)
  await mkdir(join(root, 'output'))
  await writeFile(join(root, 'request.json'), JSON.stringify({ protocol: 1, format: 'iostore', inspectOnly: false,
    maxOutputBytes: rawBytes + 264 }))
  const result = await runUnrealDecoder(await locateUnrealDecoder(), root)
  const mesh = ioStoreResult(result, { inspectOnly: false, version: 8, chunks: 3, partitions: 2 }).entries[1].mesh
  assert.equal(mesh.limited, true)
  assert.deepEqual(mesh.lods.map(lod => lod.lod), [0])
  assert.deepEqual(mesh.missing, [1])
})

test('IoStore Zen material parameters and verified dependencies reach GLBs and selective export', withDecoder, async t => {
  const root = await testDirectory(t)
  const destination = join(root, 'export')
  await mkdir(destination)
  const server = await startServer(root)
  try {
    for (const mode of ['ue53', 'ue54', 'wrongHash']) {
      const fixture = await writeIoStoreFixture(root, mode, zenMaterialFixture(mode))
      const withFbx = mode === 'ue54' && process.env.ASSET_VIEWER_TEST_NATIVE_BLENDER === '1'
      const { package: { hash } } = await (await server.post('/api/index/packages/inspect', { path: fixture.path })).json()
      const queue = async () => {
        const response = await server.post('/api/index/packages/import', {
          path: fixture.path, hash, formats: withFbx ? ['glb', 'fbx'] : ['glb'],
        })
        const body = await response.json()
        assert.equal(response.status, 202, JSON.stringify(body))
        return waitForJob(server, body.job.id)
      }
      const job = await queue()
      assert.equal(job.status, 'completed', job.error)
      const { directory, report } = job.result
      const readJson = async path => JSON.parse(await readFile(join(directory, path), 'utf8'))
      assert.deepEqual(report.materials, { converted: 2, skipped: 0, failed: 0 })
      const { entries } = await readJson('manifest.json')
      const mesh = entries.find(row => row.path.endsWith('/Sample.uasset'))
      const bulk = entries.find(row => row.path.endsWith('/Sample.ubulk'))
      const material = entries.find(row => row.path.endsWith('/MI_Paint.uasset'))
      const parent = entries.find(row => row.path.endsWith('/M_Base.uasset'))
      const texture = entries.find(row => row.path.endsWith('/T_Color.uasset'))
      const derivative = entry => entry.exports.find(row => row.role === 'material' || row.role === 'texture')
      const description = await readJson(derivative(material).path)
      const graph = await readJson('dependencies.json')
      assert.equal(graph.status, 'partial')
      assert.equal(description.parent, parent.path)
      assert.equal(description.parentStatus, 'resolved')
      assert.equal(description.parameters.scalars[0].value, .375)
      assert.deepEqual(description.parameters.vectors[0].value, [.25, .5, .75, 1])
      assert.equal(description.textureStreaming[0].path, texture.path)
      assert.ok(graph.entries.some(row => row.source === mesh.id && row.target === material.id && row.slot === 0))
      assert.ok(graph.entries.some(row => row.source === material.id && row.target === parent.id))
      const packedModel = mesh.exports.find(product => product.format === 'glb' && product.lod === 0)
      const packedBytes = await readFile(join(directory, packedModel.path))
      const model = JSON.parse(packedBytes.toString('utf8', 20, 20 + packedBytes.readUInt32LE(12)))
      const paint = model.materials.find(row => row.name === 'Paint').pbrMetallicRoughness
      if (mode === 'wrongHash') {
        assert.equal(description.parameters.textures[0].status, 'missing')
        assert.equal(paint.baseColorTexture, undefined)
        assert.ok(graph.entries.some(row => row.source === material.id && row.parameter === 'BaseColor' &&
          row.status === 'missing' && row.target === null))
        continue
      }
      assert.equal(report.meshes.texturedGltf, 2)
      assert.equal(description.bindings[0].path, derivative(texture).path)
      assert.equal(description.bindings[0].corroborated, true)
      assert.equal(paint.baseColorTexture.index, 0)
      assert.equal(paint.roughnessFactor, .375)
      assert.equal(model.images[0].mimeType, 'image/png')
      assert.equal(model.materials.find(row => row.name === 'Trim').pbrMetallicRoughness.baseColorTexture, undefined)
      if (withFbx) {
        const fbx = mesh.exports.filter(row => row.format === 'fbx' && row.path)
        assert.ok(fbx.every(row => row.from.endsWith('-materials.gltf')))
        assert.deepEqual(await readFbxGeometry(fbx.map(row => join(directory, row.path))), [[2, 2, 1, 2], [1, 2, 1, 1]])
      }
      assert.equal((await queue()).result.reused, true)
      if (mode !== 'ue54') continue
      const route = '/api/index/jobs/' + job.id
      const asset = entries.indexOf(mesh)
      const plan = await (await server.post(route + '/export-plan', { destination, asset })).json()
      const publication = await server.post(route + '/export', { destination, asset, key: plan.key })
      const body = await publication.json()
      assert.equal(publication.status, 201, JSON.stringify(body))
      for (const product of [packedModel, derivative(material), derivative(parent), derivative(texture),
        material.artifact, parent.artifact, texture.artifact, bulk.artifact]) {
        assert.deepEqual(await readFile(join(body.directory, product.path)), await readFile(join(directory, product.path)))
      }
      await writeFile(join(directory, 'dependencies.json'), JSON.stringify({ ...graph, entries: [] }))
      assert.equal((await server.post(route + '/export-plan', { destination, asset })).status, 409)
      assert.match((await queue()).error, /Кеш импорта Unreal IoStore повреждён/)
      assert.deepEqual(await readFile(fixture.path), fixture.toc)
    }
  } finally { await server.close() }
})

test('IoStore rejects invalid directory links and bad chunk hashes and reports unsupported codecs', withDecoder, async t => {
  const root = await testDirectory(t)
  const directory = join(root, 'imports')
  const attempt = (path, inspectOnly = false) => processIoStore({ root, path }, { directory, inspectOnly })

  for (const [name, options, issue] of [
    ['Traversal', { soundName: '../escaped.wav' }, 'unreal-iostore-path'],
    ['Cycle', { cycle: true }, 'unreal-iostore-directory'],
  ]) {
    const { path } = await writeIoStoreFixture(root, name, options)
    assert.equal((await attempt(path, true)).issue, issue)
  }
  const legacy = await writeIoStoreFixture(root, 'Legacy', { version: 3, secondPartition: false, audioOffset: 0 })
  const legacyResult = await attempt(legacy.path)
  assert.equal(legacyResult.status, 'completed', legacyResult.issue)
  assert.deepEqual(legacyResult.extractedTypes, { package: 1, bulk: 1, file: 0, registry: 0 })

  const codec = await writeIoStoreFixture(root, 'Unsupported', { unsupportedCodec: true })
  const preview = await attempt(codec.path, true)
  assert.equal(preview.status, 'completed')
  assert.equal(preview.entries.find(row => row.kind === 'file').issue, 'unreal-iostore-compression')

  const fixture = await writeIoStoreFixture(root, 'Invalid')
  const corrupted = Buffer.from(fixture.data[0])
  corrupted[80] ^= 1
  await writeFile(fixture.partitionPaths[0], corrupted)
  const result = await attempt(fixture.path)
  assert.equal(result.issue, 'unreal-iostore-chunk-hash')
  assert.equal(result.output, undefined)
})
