import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { oggVorbis } from '../core/conversion/audio/ogg-vorbis.mjs'
import { ioStoreResult } from '../core/engines/unreal/decoder/protocol.mjs'
import { processIoStore } from '../core/packages/unreal/iostore/import.mjs'
import { writeIoStoreFixture } from './fixtures/unreal-iostore.mjs'
import { zenOgg } from './fixtures/unreal-zen-audio.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const withDecoder = { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 30_000 }
const vorbisMetrics = { channels: 1, sampleRate: 16000, frames: 8000 }

test('Vorbis framing verifies the stream and rejects corrupt pages and truncation', () => {
  assert.deepEqual(oggVorbis(zenOgg), vorbisMetrics)
  const corrupt = Buffer.from(zenOgg)
  corrupt[corrupt.length - 1] ^= 1
  assert.equal(oggVorbis(corrupt), null)
  assert.equal(oggVorbis(zenOgg.subarray(0, -1)), null)
  assert.equal(oggVorbis(Buffer.concat([zenOgg, zenOgg])), null)
})

test('IoStore protocol confines SoundWave derivatives to numbered outputs from package chunks', () => {
  const source = { version: 8, chunks: 1, partitions: 2 }
  const entry = { path: 'Sample.uasset', size: 440, status: 'extracted', issue: null, output: 0,
    chunkId: '9d2fbb016ac3df0c00000001', kind: 'package' }
  const report = { protocol: 1, status: 'completed', containerVersion: 8, chunks: 1, partitions: 2,
    textureDecoder: 1, audioDecoder: 1 }
  const accept = (row, options = {}) => ioStoreResult({ ...report, entries: [{ ...entry, ...row }] }, { ...source, ...options })
  const audio = { format: 'ogg', size: 400, file: '../../escape.ogg' }
  assert.deepEqual(accept({ audio }).entries[0].audio, { format: 'ogg', size: 400, file: '00000.ogg' })
  assert.equal(accept({ audio: { ...audio, format: 'js' } }), null)
  assert.equal(accept({ audio: { ...audio, size: 40 * 1024 ** 2 } }), null)
  assert.equal(accept({ audio, audioIssue: 'unreal-iostore-audio-format' }), null)
  assert.equal(accept({ audio, textureIssue: 'unreal-iostore-texture-limit' }), null)
  assert.equal(accept({ audio, path: 'Sample.wav', kind: 'file' }), null)
  assert.equal(accept({ audio, status: 'available', output: null }, { inspectOnly: true }), null)
  assert.equal(accept({ audioIssue: 'unreal-iostore-texture-limit' }), null)
})

test('Cooked SoundWave preserves native chunks and diagnoses unavailable or invalid output', withDecoder, async t => {
  const root = await testDirectory(t)
  const directory = join(root, 'imports')
  for (const [name, options, state, issue] of [
    ['Inline', { soundWave: 'pcm' }, 'converted'],
    ['Unsupported', { soundWave: 'unsupported' }, 'skipped', 'unreal-iostore-audio-format'],
    ['Foreign', { soundWave: 'vorbis', bulkName: 'Other.ubulk' }, 'skipped', 'unreal-iostore-audio-bulk-unavailable'],
    ['Damaged', { soundWave: 'corrupt' }, 'failed', 'unreal-iostore-audio-output'],
  ]) {
    const fixture = await writeIoStoreFixture(root, name, options)
    const result = await processIoStore({ root, path: fixture.path }, { directory })
    assert.equal(result.status, 'completed', result.issue)
    assert.equal(result.audio[state], 1)
    const { entries } = JSON.parse(await readFile(join(result.output, 'manifest.json'), 'utf8'))
    const asset = entries.find(row => row.kind === 'package')
    const bulk = entries.find(row => row.kind === 'bulk')
    assert.deepEqual(await readFile(join(result.output, asset.artifact.path)), fixture.payloads.asset)
    assert.deepEqual(await readFile(join(result.output, bulk.artifact.path)), fixture.payloads.bulk)
    const [audio] = asset.exports
    assert.equal(audio.status, state)
    assert.equal(audio.issue, issue)
    if (state === 'converted') {
      assert.equal(audio.format, 'wav')
      assert.deepEqual(await readFile(join(result.output, audio.path)), fixture.payloads.soundWave)
    } else {
      assert.equal(audio.path, undefined)
    }
  }
})

test('Streamed Zen SoundWave is indexed, exports its companions and verifies the existing cache', withDecoder, async t => {
  const root = await testDirectory(t)
  const destination = join(root, 'export')
  await mkdir(destination)
  const fixture = await writeIoStoreFixture(root, 'Streamed', { soundWave: 'vorbis' })
  const server = await startServer(root)
  const read = async path => {
    const response = await server.request('/api/index/' + path)
    assert.equal(response.status, 200)
    return response.json()
  }
  async function settle(id) {
    const deadline = Date.now() + 8000
    do {
      const { job } = await read('jobs/' + id)
      if (!['pending', 'running'].includes(job.status)) return job
      await delay(50)
    } while (Date.now() < deadline)
    assert.fail('Job did not settle: ' + id)
  }

  try {
    const inspected = await server.post('/api/index/packages/inspect', { path: fixture.path })
    assert.equal(inspected.status, 200)
    const { package: { hash } } = await inspected.json()
    const importSound = async () => {
      const queued = await server.post('/api/index/packages/import', { path: fixture.path, hash })
      assert.equal(queued.status, 202)
      return settle((await queued.json()).job.id)
    }
    const job = await importSound()
    assert.equal(job.status, 'completed', job.error)
    const { directory, library, scanJobId, report } = job.result
    assert.deepEqual(report.audio, { converted: 1, skipped: 0, failed: 0 })
    assert.equal((await settle(scanJobId)).status, 'completed')
    const route = '/api/index/jobs/' + job.id
    const { assets: entries } = await read('jobs/' + job.id + '/manifest')
    const asset = entries.find(row => row.kind === 'package')
    const bulk = entries.find(row => row.kind === 'bulk')
    const [audio] = asset.exports
    assert.equal(audio.format, 'ogg')
    for (const [key, value] of Object.entries(vorbisMetrics)) assert.equal(audio[key], value)
    assert.deepEqual(await readFile(join(directory, audio.path)), zenOgg)
    const { assets } = await read('search?library=' + library.id)
    assert.ok(assets.some(row => row.name === 'Sample.ogg'))
    const ordinal = entries.indexOf(asset)
    const plan = await server.post(route + '/export-plan', { destination, asset: ordinal })
    assert.equal(plan.status, 200)
    const publication = await server.post(route + '/export', { destination, asset: ordinal, key: (await plan.json()).key })
    assert.equal(publication.status, 201)
    const exported = (await publication.json()).directory
    assert.deepEqual(await readFile(join(exported, audio.path)), zenOgg)
    assert.deepEqual(await readFile(join(exported, asset.artifact.path)), fixture.payloads.asset)
    assert.deepEqual(await readFile(join(exported, bulk.artifact.path)), fixture.payloads.bulk)
    assert.equal((await importSound()).result.reused, true)
    const changed = Buffer.from(zenOgg)
    changed[100] ^= 1
    await writeFile(join(directory, audio.path), changed)
    assert.match((await importSound()).error, /Кеш импорта Unreal IoStore повреждён/)
    assert.deepEqual(await readFile(fixture.path), fixture.toc)
    assert.deepEqual(await readFile(fixture.partitionPaths[1]), fixture.data[1])
  } finally {
    await server.close()
  }
})
