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
import { processIoStore } from '../core/packages/unreal/iostore/import.mjs'
import { makeIoStore, writeIoStoreFixture } from './fixtures/unreal-iostore.mjs'
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
    texture: { width: 2, height: 2, size: 94, mip: 0, pixelFormat: 'PF_B8G8R8A8', srgb: true } }
  const result = { protocol: 1, status: 'completed', containerVersion: 8, chunks: 1, partitions: 2,
    textureDecoder: 1, entries: [entry] }
  assert.equal(ioStoreResult(result, options).entries[0].texture.file, '00000.png')
  assert.equal(ioStoreResult({ ...result, textureDecoder: undefined }, options), null)
  assert.equal(ioStoreResult({ ...result, entries: [{ ...entry, path: 'Sample.umap' }] }, options), null)
  assert.equal(ioStoreResult({ ...result, entries: [{ ...entry, textureIssue: 'unreal-iostore-texture-limit' }] }, options), null)
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
