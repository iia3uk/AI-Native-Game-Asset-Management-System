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
  assert.equal(png.subarray(37, 41).toString('ascii'), 'IDAT')
  const pixels = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))
  const pixel = (x, y) => {
    const offset = y * (entry.width * 4 + 1) + 1 + x * 4
    return [...pixels.subarray(offset, offset + 4)]
  }
  return { entry, pixel }
}
