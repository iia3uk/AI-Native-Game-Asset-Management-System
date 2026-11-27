import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pakResult } from '../core/engines/unreal/decoder/protocol.mjs'
import { locateUnrealDecoder } from '../core/engines/unreal/decoder/run.mjs'
import { generateFixtures } from '../scripts/generate-fixtures.mjs'
import { makeModernPak, makePak, wavTone } from './fixtures/unreal-pak.mjs'
import { testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))

test('rejects worker reports that could publish paths outside their category or mismatch staged outputs', () => {
  const entry = { path: 'Fixture/Content/Tone.wav', size: 48, status: 'extracted', issue: null, output: 0 }
  const result = { protocol: 1, status: 'completed', containerVersion: 4, entries: [entry] }
  const options = { inspectOnly: false, version: 4 }
  assert.equal(pakResult(result, options).entries[0].file, '00000.bin')
  for (const path of ['../../Tone.wav', 'Fixture/CON.wav', 'Fixture/C:\\Tone.wav', 'Fixture/LPT².wav']) {
    assert.equal(pakResult({ ...result, entries: [{ ...entry, path }] }, options), null)
  }
  assert.equal(pakResult({ ...result, entries: [{ ...entry, output: 5 }] }, options), null)
  assert.equal(pakResult({ ...result, entries: [entry, { ...entry, output: 1, path: entry.path.toLowerCase() }] }, options), null)
  assert.equal(pakResult({ ...result, entries: [entry, { ...entry, path: entry.path + '/Sub.wav', output: 1 }] }, options), null)
})

test('encrypted Pak index is rejected before looking up the worker or creating an index', async t => {
  const root = await testDirectory(t)
  const path = join(root, 'Protected.pak')
  await writeFile(path, makePak([{ path: 'Tone.wav', content: wavTone() }], { encryptedIndex: true }))
  const data = join(root, 'data')
  await assert.rejects(run(process.execPath, [cli, 'unreal-extract', path, '--json'], {
    env: { ...process.env, ASSET_VIEWER_DATA_DIR: data, ASSET_VIEWER_CUE4PARSE: 'invalid-relative-override' },
  }), error => {
    assert.equal(error.code, 1)
    assert.equal(JSON.parse(error.stdout).issue, 'unreal-pak-encrypted')
    return true
  })
  await assert.rejects(readdir(data), { code: 'ENOENT' })
})

test('native CUE4Parse reads, extracts and indexes self-authored model and audio from a stock Pak',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 45_000 }, async t => {
    const root = await testDirectory(t)
    assert.ok(await locateUnrealDecoder(), 'Build the native worker before running this test.')
    const data = join(root, 'data')
    const env = { ...process.env, ASSET_VIEWER_DATA_DIR: data }
    const args = (command, ...params) => [cli, command, ...params, '--json']
    const query = async (...argv) => JSON.parse((await run(process.execPath, args(...argv), { env })).stdout)
    const assertIssue = async (path, issue) => assert.rejects(run(process.execPath, args('unreal-extract', path), { env }), error => {
      assert.equal(error.code, 1)
      assert.equal(JSON.parse(error.stdout).issue, issue)
      return true
    })
    const fixtures = join(root, 'fixtures')
    await generateFixtures(fixtures)
    const mesh = await readFile(join(fixtures, 'Architecture', 'woodland-cabin.glb'))
    const audio = wavTone()
    const input = join(root, 'Generated.pak')
    const archive = makePak([
      { path: 'Models/Cabin.glb', content: mesh },
      { path: 'Audio/Tone.wav', content: audio },
      { path: 'Scripts/start.py', content: Buffer.from('should never be written') },
      { path: 'Audio/Protected.wav', content: audio, encrypted: true },
      { path: 'Audio/Invalid.wav', content: Buffer.from('not a WAV file') },
    ])
    await writeFile(input, archive)
    const inspection = await query('unreal-extract', input, '--inspect')
    assert.equal(inspection.total, 5)
    assert.ok(inspection.entries.some(entry => entry.issue === 'unreal-pak-encrypted-entry'))
    assert.ok(inspection.entries.some(entry => entry.path.endsWith('/Scripts/start.py') && entry.status === 'skipped'))
    await assert.rejects(readdir(data), { code: 'ENOENT' })

    const output = await query('unreal-extract', input)
    assert.equal(output.extracted, 2)
    assert.equal(output.skipped, 3)
    const manifest = JSON.parse(await readFile(join(output.output, 'manifest.json'), 'utf8'))
    const actual = manifest.entries.filter(entry => entry.status === 'extracted')
    for (const entry of actual) {
      assert.match(entry.artifact.sha256, /^[0-9a-f]{64}$/)
      assert.deepEqual(await readFile(join(output.output, entry.artifact.path)), entry.format === 'glb' ? mesh : audio)
    }
    assert.equal((await query('search', '--library', output.library.id)).assets.length, 2)
    const [asset] = (await query('search', '--library', output.library.id, '--kind', 'model')).assets
    assert.ok((await query('inspect', asset.id)).analysis.metrics.triangles > 0)
    assert.deepEqual(await readFile(input), archive)

    const dangerous = join(root, 'Dangerous.pak')
    await writeFile(dangerous, makePak([{ path: '../Escape.wav', content: audio }]))
    await assertIssue(dangerous, 'unreal-pak-path')
    await writeFile(dangerous, makePak([
      { path: 'Same.wav', content: audio }, { path: 'Same.wav', content: audio },
    ]))
    await assertIssue(dangerous, 'unreal-pak-path-collision')
    const broken = join(root, 'Corrupt.pak')
    const corrupt = makePak([{ path: 'Audio/Tone.wav', content: audio }])
    corrupt[53] ^= 1
    await writeFile(broken, corrupt)
    await assertIssue(broken, 'unreal-pak-payload-hash')
    corrupt[53] ^= 1
    corrupt[53 + audio.length + 4] ^= 1
    await writeFile(broken, corrupt)
    await assertIssue(broken, 'unreal-pak-index-hash')
    assert.deepEqual(await readdir(join(data, 'imports', 'unreal-pak-v1')), [output.output.split(/[\\/]/).pop()])

    const modern = join(root, 'Modern.pak')
    const modernArchive = makeModernPak([
      { path: 'Cabin.glb', content: mesh, compressed: true },
      { path: 'Audio/Tone.wav', content: audio },
    ])
    await writeFile(modern, modernArchive)
    const unpacked = await query('unreal-extract', modern)
    assert.equal(unpacked.containerVersion, 11)
    assert.equal(unpacked.extracted, 2)
    const modernManifest = JSON.parse(await readFile(join(unpacked.output, 'manifest.json'), 'utf8'))
    const glb = modernManifest.entries.find(entry => entry.format === 'glb')
    assert.deepEqual(await readFile(join(unpacked.output, glb.artifact.path)), mesh)
    modernArchive[modernArchive.length - 222] ^= 1
    await writeFile(broken, modernArchive)
    await assertIssue(broken, 'unreal-pak-index-hash')
  })
