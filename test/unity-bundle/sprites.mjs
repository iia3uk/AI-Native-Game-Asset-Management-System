import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readTexture } from './png.mjs'

export async function verifyBundleSprites(root, data, query) {
  const input = join(root, 'Bundles', 'sprites.bundle')
  const before = await readFile(input)
  const inspected = await query('unity-bundle', input, '--inspect')
  assert.equal(inspected.status, 'completed', JSON.stringify(inspected))
  assert.equal(inspected.total, 4)
  const sheet = inspected.assets.find(asset => asset.name === 'SpriteSheet')
  assert.equal(sheet.classId, 28)
  const available = inspected.assets.filter(asset => asset.classId === 213 && asset.status === 'available')
  assert.equal(available.length, 2, JSON.stringify(inspected))
  assert.ok(inspected.assets.some(asset => asset.issue === 'unity-bundle-sprite-texture-reference'))
  await assert.rejects(readdir(data), { code: 'ENOENT' })

  const exported = await query('unity-bundle', input)
  assert.deepEqual(exported.counts, { converted: 3, unsupported: 1 })
  const manifest = JSON.parse(await readFile(join(exported.output, 'manifest.json'), 'utf8'))
  const dependencies = JSON.parse(await readFile(join(exported.output, 'dependencies.json'), 'utf8'))
  assert.deepEqual(dependencies, {
    version: 1, status: 'partial', entries: available.map(({ member, pathId }) => ({
      type: 'sprite-texture', from: { member, pathId }, to: { member, pathId: sheet.pathId },
    })),
  })
  for (const [name, x, y, width, height] of [['LowerSprite', 1, 0, 3, 4], ['UpperSprite', 4, 5, 4, 2]]) {
    const expected = { texturePathId: sheet.pathId, x, y }
    const listed = available.find(asset => asset.name === name)
    assert.deepEqual(listed.sprite, expected)
    assert.deepEqual([listed.width, listed.height], [width, height])
    const { entry, pixel } = await readTexture(manifest, exported.output, name)
    assert.deepEqual(entry.sprite, expected)
    assert.equal(entry.pathId, listed.pathId)
    assert.deepEqual([entry.width, entry.height], [width, height])
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const sourceX = x + col
        const sourceY = y + height - 1 - row
        assert.deepEqual(pixel(col, row), [32 * sourceX, 32 * sourceY, 99, 11 * (sourceX + sourceY)])
      }
    }
    const { assets } = await query('search', name, '--library', exported.library.id)
    assert.deepEqual(assets.map(asset => [asset.ext, asset.kind]), [['png', 'image']])
  }
  assert.deepEqual(await readFile(input), before)
  const repeated = await query('unity-bundle', input)
  assert.deepEqual([repeated.reused, repeated.output], [true, exported.output])

  const native = await readFile(join(root, 'Bundles', 'uncompressed', 'sprites.bundle'))
  const fields = [1, 0, 3, 4, 0, 0, -1, -1]
  const rect = Buffer.alloc(32)
  fields.forEach((value, index) => rect.writeFloatLE(value, index * 4))
  const offset = native.indexOf(rect)
  assert.ok(offset >= 0, 'Find the serialized LowerSprite texture rectangle')
  assert.equal(native.lastIndexOf(rect), offset)
  assert.equal(native.readUInt32LE(offset + rect.length), 0)
  const lower = available.find(asset => asset.name === 'LowerSprite')
  for (const [label, issue, edit] of [
    ['outside', 'rect', bytes => bytes.writeFloatLE(8, offset)],
    ['fractional', 'rect', bytes => bytes.writeFloatLE(1.5, offset)],
    ['packed', 'packing', bytes => bytes.writeUInt32LE(1, offset + rect.length)],
  ]) {
    const malformed = Buffer.from(native)
    edit(malformed)
    const path = join(root, 'sprite-' + label + '.bundle')
    await writeFile(path, malformed)
    const report = await query('unity-bundle', path, '--inspect')
    assert.equal(report.status, 'completed', JSON.stringify(report))
    assert.equal(report.assets.find(asset => asset.pathId === lower.pathId).issue, 'unity-bundle-sprite-' + issue)
    assert.ok(report.assets.some(asset => asset.name === 'UpperSprite' && asset.status === 'available'))
  }
}
