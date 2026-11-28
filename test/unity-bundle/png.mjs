import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

export async function readTexture(manifest, output, name, method = 'assetstools-unityfs') {
  const entry = manifest.assets.find(asset => asset.name === name)
  assert.ok(entry, 'Missing decoded PNG: ' + name)
  assert.equal(entry.artifact.method, method + '-' + (entry.sprite ? 'sprite-' : '') + entry.textureEncoding)
  const png = await readFile(join(output, entry.artifact.path))
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[25]], [entry.width, entry.height, 6])
  const chunks = new Map()
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at)
    chunks.set(png.toString('ascii', at + 4, at + 8), png.subarray(at + 8, at + 8 + size))
    at += size + 12
  }
  assert.equal(chunks.has('gAMA'), entry.textureColorSpace === 'linear')
  assert.equal(chunks.has('sRGB'), entry.textureColorSpace === 'srgb')
  if (chunks.has('gAMA')) assert.equal(chunks.get('gAMA').readUInt32BE(), 100_000)
  if (chunks.has('sRGB')) assert.deepEqual(chunks.get('sRGB'), Buffer.from([0]))
  const pixels = inflateSync(chunks.get('IDAT'))
  const pixel = (x, y) => {
    const offset = y * (entry.width * 4 + 1) + 1 + x * 4
    return [...pixels.subarray(offset, offset + 4)]
  }
  return { entry, pixel }
}
