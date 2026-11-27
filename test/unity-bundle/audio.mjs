import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runBundleWorker } from '../../core/engines/unity/bundle/run.mjs'

const clips = {
  MonoPcm: { channels: 1, sampleRate: 22050, frames: 1001 },
  StereoPcm: { channels: 2, sampleRate: 48000, frames: 2309 },
}

export async function verifyBundleAudio(root, data, query, worker) {
  const input = join(root, 'Bundles', 'audio.bundle')
  const source = await readFile(input)
  const inspected = await query('unity-bundle', input, '--inspect')
  assert.equal(inspected.status, 'completed', JSON.stringify(inspected))
  assert.equal(inspected.total, 3)
  assert.equal(inspected.assets.find(asset => asset.name === 'StereoVorbis').issue, 'unity-bundle-audio-codec')
  await assert.rejects(readdir(data), { code: 'ENOENT' })
  const output = await query('unity-bundle', input)
  assert.deepEqual(output.counts, { converted: 2, unsupported: 1 })
  const manifest = JSON.parse(await readFile(join(output.output, 'manifest.json'), 'utf8'))
  for (const [name, metadata] of Object.entries(clips)) {
    assert.deepEqual(inspected.assets.find(asset => asset.name === name).audio, metadata)
    const entry = manifest.assets.find(asset => asset.name === name)
    assert.deepEqual(entry.audio, metadata)
    assert.equal(entry.artifact.format, 'wav')
    assert.equal(entry.artifact.method, 'assetstools-unityfs-fsb5-pcm16')
    assert.match(entry.artifact.path, /^Audio\//)
    const actual = await readFile(join(output.output, entry.artifact.path))
    const original = await readFile(join(root, 'BundleProject', 'Assets', 'BundleFixture', name + '.wav'))
    assert.deepEqual(actual, original)
    const { assets } = await query('search', name, '--library', output.library.id)
    assert.equal(assets.length, 1)
    assert.equal(assets[0].ext, 'wav')
  }
  assert.deepEqual(await readFile(input), source)
  const reused = await query('unity-bundle', input)
  assert.deepEqual([reused.reused, reused.output], [true, output.output])

  const native = await readFile(join(root, 'Bundles', 'uncompressed', 'audio.bundle'))
  const banks = native.toString('latin1').matchAll(/FSB5/g)
  const stereo = Array.from(banks, match => match.index).find(index =>
    native.readUInt32LE(index + 24) === 2 && native.readBigUInt64LE(index + 60) >> 34n === BigInt(clips.StereoPcm.frames))
  assert.ok(stereo > 0)
  const bankSize = 60 + native.readUInt32LE(stereo + 12) + native.readUInt32LE(stereo + 16) + native.readUInt32LE(stereo + 20)
  const member = inspected.assets[0].member
  const resource = 'archive:/' + member + '/' + member + '.resource'
  const nameAt = native.indexOf('StereoPcm')
  assert.ok(nameAt > 0)
  const link = native.indexOf(resource, nameAt)
  assert.ok(link > nameAt)
  assert.equal(native.readUInt32LE(link - 4), resource.length)
  const offset = Math.ceil((link + resource.length) / 4) * 4
  assert.equal(native.readBigUInt64LE(offset + 8), BigInt(bankSize))
  for (const [name, issue, edit] of [
    ['path', 'stream-path', bytes => bytes.write('../external/', link, 'ascii')],
    ['range', 'stream-range', bytes => bytes.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, offset)],
    ['bank', 'bank-size', bytes => bytes.writeUInt32LE(0xffff_ffff, stereo + 20)],
    ['layout', 'bank-layout', bytes => bytes.writeUInt32LE(2, stereo + 8)],
  ]) {
    const bytes = Buffer.from(native)
    edit(bytes)
    const path = join(root, 'bad-audio-' + name + '.bundle')
    await writeFile(path, bytes)
    const report = await query('unity-bundle', path, '--inspect')
    assert.equal(report.status, 'completed', JSON.stringify(report))
    assert.ok(report.assets.some(asset => asset.issue === 'unity-bundle-audio-' + issue), JSON.stringify(report))
    assert.equal(report.assets.filter(asset => asset.format === 'wav').length, 1)
  }

  const limited = join(root, 'audio-limit')
  await mkdir(join(limited, 'output'), { recursive: true })
  await writeFile(join(limited, 'input.bundle'), source)
  await writeFile(join(limited, 'request.json'), '{"protocol":1,"inspectOnly":false,"outputLimit":44}')
  const report = await runBundleWorker(worker, limited)
  assert.equal(report.assets.filter(asset => asset.issue === 'unity-bundle-output-limit').length, 2)
  assert.deepEqual(await readdir(join(limited, 'output')), [])
}
