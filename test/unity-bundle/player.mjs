import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readTexture } from './png.mjs'
import { verifyBcTextures } from './bc-textures.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function verifyPlayerExports(root, files, plan, job, query) {
  const { directory, library, report } = job.result
  assert.deepEqual(report.counts, { converted: 10, unsupported: 1 })
  assert.equal(report.packageFormat, 'unity-serialized')
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.source.sha256, plan.hash)
  assert.equal(manifest.source.contentsSha256, hash(await readFile(files.primary)))
  assert.deepEqual(manifest.source.resources, plan.resources)
  for (const resource of plan.resources) {
    const contents = await readFile(files[resource.role])
    assert.equal(resource.size, contents.length)
    assert.equal(resource.sha256, hash(contents))
  }
  const texture = await readTexture(manifest, directory, 'StreamedDXT5', 'assetstools-unity-serialized')
  assert.equal(texture.entry.textureStorage, 'companion')
  assert.deepEqual([texture.entry.width, texture.entry.height], [512, 512])
  for (const [actual, expected] of [
    [texture.pixel(20, 20), [0, 255, 0, 204]], [texture.pixel(20, 490), [255, 0, 0, 51]],
  ]) assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]) <= 8), String(actual))
  assert.deepEqual((await query('search', 'StreamedDXT5', '--library', library.id)).assets.map(asset => asset.ext), ['png'])
  await verifyBcTextures(manifest, directory, 'assetstools-unity-serialized', 'companion')
  assert.deepEqual((await query('search', 'StreamedBC7', '--library', library.id)).assets.map(asset => asset.ext), ['png'])
  for (const name of ['MonoPcm', 'StereoPcm']) {
    const entry = manifest.assets.find(asset => asset.name === name)
    assert.equal(entry.artifact.method, 'assetstools-unity-serialized-fsb5-pcm16')
    assert.deepEqual(await readFile(join(directory, entry.artifact.path)),
      await readFile(join(root, 'PlayerProject', 'Assets', 'Resources', name + '.wav')))
    assert.deepEqual((await query('search', name, '--library', library.id)).assets.map(asset => asset.ext), ['wav'])
  }
}

export async function verifyPlayerMalformed(files, inspect) {
  const bytes = await readFile(files.primary)
  const reference = 'resources.assets.resS'
  const at = bytes.indexOf(reference)
  assert.ok(at > 0)
  assert.equal(bytes.readUInt32LE(at - 4), reference.length)
  for (const [issue, edit] of [
    ['unity-bundle-texture-stream-path', data => data.write('../', at, 'ascii')],
    ['unity-bundle-texture-stream-range', data => data.writeUInt32LE(0xffff_ffff, at - 8)],
    ['unity-bundle-type-tree', data => data.writeUIntBE(0x3939, 48, 2)],
  ]) {
    const changed = Buffer.from(bytes)
    edit(changed)
    await writeFile(files.primary, changed)
    assert.ok((await inspect()).assets.some(asset => asset.issue === issue), issue)
  }
  await writeFile(files.primary, bytes)

  await rename(files.texture, files.texture + '.off')
  await rename(files.audio, files.audio + '.off')
  try {
    const plan = await inspect()
    assert.equal(plan.hash, hash(bytes))
    assert.deepEqual(plan.assets.filter(asset => asset.status === 'available').map(asset => asset.name).sort(),
      ['Albedo', 'InlineBC4', 'InlineBC5', 'InlineBC7', 'InlineDXT1', 'InlineDXT5'])
    assert.ok(plan.assets.some(asset => asset.issue === 'unity-bundle-texture-stream-missing'))
    assert.ok(plan.assets.some(asset => asset.issue === 'unity-bundle-audio-stream-missing'))
  } finally {
    await rename(files.texture + '.off', files.texture)
    await rename(files.audio + '.off', files.audio)
  }
}
