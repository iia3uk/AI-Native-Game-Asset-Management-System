import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { planPackageCleanup } from '../../core/packages/cleanup/plan.mjs'
import { readTexture } from './png.mjs'

export async function verifyBundleAtlas(root, data, query) {
  const input = join(root, 'Bundles', 'Atlas', 'atlas.bundle')
  const before = await readFile(input)
  const report = await query('unity-bundle', input, '--inspect')
  assert.equal(report.status, 'completed', JSON.stringify(report))
  const atlas = report.assets.find(asset => asset.classId === 687078895)
  const sheet = report.assets.find(asset => asset.classId === 28)
  const sprites = report.assets.filter(asset => asset.classId === 213)
  assert.deepEqual([atlas.issue, sheet.status, sprites.length], ['unity-bundle-sprite-atlas-container', 'available', 2])
  const output = await query('unity-bundle', input)
  const manifest = await readManifest(output)
  assert.equal(output.converted, 3)
  for (const [name, width, height, blue] of [['Panel', 13, 9, 41], ['Button', 8, 6, 103]]) {
    const sprite = sprites.find(asset => asset.name === name)
    const image = await readTexture(manifest, output.output, name)
    assert.deepEqual([sprite.status, image.entry.width, image.entry.height], ['available', width, height])
    assert.deepEqual(image.entry.sprite, sprite.sprite)
    assert.equal(sprite.sprite.texturePathId, sheet.pathId)
    assert.deepEqual(sprite.sprite.packed, { atlasPathId: atlas.pathId, width, height, offsetX: 0, offsetY: 0, rotation: 0 })
    verifyPixels(image, width, height, blue)
    const { assets } = await query('search', name, '--library', output.library.id)
    assert.deepEqual(assets.map(asset => [asset.ext, asset.kind]), [['png', 'image']])
  }
  assert.deepEqual(await readFile(input), before)
  const repeated = await query('unity-bundle', input)
  assert.deepEqual([repeated.reused, repeated.output], [true, output.output])

  const { job } = await query('package-import', input)
  const cleanup = (source, job) => planPackageCleanup({ imports: join(data, 'imports'), protectedRoots: [data],
    source, job, signal: AbortSignal.timeout(10_000) })
  assert.deepEqual((await cleanup(input, job)).files.map(file => file.original.path), [input])
  const ordinal = String(manifest.assets.findIndex(asset => asset.name === 'Button'))
  const plan = await query('package-export', job.id, root, '--asset', ordinal)
  assert.deepEqual([plan.assets, plan.unresolved], [2, 0])
  const saved = await query('package-export', job.id, root, '--asset', ordinal, '--plan-key', plan.key)
  const selection = await readManifest({ output: saved.directory })
  assert.deepEqual(selection.assets.map(asset => asset.name), ['Button', sheet.name])

  const button = sprites.find(asset => asset.name === 'Button')
  const { rect, key, settings } = atlasRow(before, button)
  const originalSettings = before.readUInt32LE(settings)
  for (const rotation of [1, 2, 3]) {
    const edited = Buffer.from(before)
    edited.writeUInt32LE(originalSettings | rotation << 2, settings)
    const path = join(root, 'atlas-rotation-' + rotation + '.bundle')
    await writeFile(path, edited)
    const rotated = await query('unity-bundle', path)
    const image = await readTexture(await readManifest(rotated), rotated.output, 'Button')
    assert.equal(image.entry.sprite.packed.rotation, rotation)
    verifyPixels(image, 8, 6, 103, rotation)
  }
  const inset = Buffer.from(before)
  for (const [offset, value] of [[8, 6], [12, 4], [16, 1], [20, 1]]) inset.writeFloatLE(value, rect + offset)
  const insetPath = join(root, 'atlas-inset.bundle')
  await writeFile(insetPath, inset)
  const insetOutput = await query('unity-bundle', insetPath)
  const { pixel } = await readTexture(await readManifest(insetOutput), insetOutput.output, 'Button')
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 8; x++) {
      const inside = x >= 1 && x <= 6 && y >= 1 && y <= 4
      assert.deepEqual(pixel(x, y), inside ? sourcePixel(x - 1, 4 - y, 103) : [0, 0, 0, 0])
    }
  }
  for (const [label, issue, edit] of [
    ['missing-key', 'atlas-key', bytes => { bytes[key] ^= 0x80 }],
    ['outside', 'rect', bytes => bytes.writeFloatLE(sheet.width, rect)],
    ['offset', 'rect', bytes => bytes.writeFloatLE(1, rect + 16)],
    ['tight', 'packing', bytes => bytes.writeUInt32LE((originalSettings & ~3) | 1, settings)],
    ['scaled', 'atlas-variant', bytes => bytes.writeFloatLE(0.5, settings - 4)],
  ]) {
    const edited = Buffer.from(before)
    edit(edited)
    const path = join(root, 'atlas-' + label + '.bundle')
    await writeFile(path, edited)
    const inspected = await query('unity-bundle', path, '--inspect')
    assert.equal(inspected.status, 'completed', JSON.stringify(inspected))
    assert.equal(inspected.assets.find(asset => asset.pathId === button.pathId).issue, 'unity-bundle-sprite-' + issue)
    assert.ok(inspected.assets.some(asset => asset.name === 'Panel' && asset.status === 'available'))
    if (label === 'missing-key') {
      const { job: partialJob } = await query('package-import', path)
      assert.equal(partialJob.status, 'completed')
      assert.deepEqual((await cleanup(path, partialJob)).files, [])
      assert.deepEqual(await readFile(path), edited)
    }
  }
}

function readManifest({ output }) {
  return readFile(join(output, 'manifest.json'), 'utf8').then(JSON.parse)
}

function sourcePixel(x, y, blue) {
  return [13 * x + 2, 19 * y + 5, blue, 91 + 3 * (x + y)]
}

function verifyPixels({ pixel }, width, height, blue, rotation = 0) {
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const x = rotation & 1 ? width - 1 - col : col
      const y = rotation & 2 ? row : height - 1 - row
      assert.deepEqual(pixel(col, row), sourcePixel(x, y, blue))
    }
  }
}

function atlasRow(bytes, { sprite }) {
  const signature = Buffer.alloc(48)
  signature.writeBigInt64LE(BigInt(sprite.texturePathId), 4)
  const { width, height, offsetX, offsetY } = sprite.packed
  const rectangle = [sprite.x, sprite.y, width, height, offsetX, offsetY]
  rectangle.forEach((value, index) => signature.writeFloatLE(value, 24 + 4 * index))
  const start = bytes.indexOf(signature)
  assert.ok(start >= 24 && start === bytes.lastIndexOf(signature), 'Find the native atlas render-data entry')
  const rect = start + 24
  const settings = rect + 52
  assert.equal(bytes.readFloatLE(settings - 4), 1)
  assert.ok([3, 0xc03].includes(bytes.readUInt32LE(settings)))
  return { rect, key: start - 24, settings }
}
