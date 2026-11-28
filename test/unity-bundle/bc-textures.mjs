import assert from 'node:assert/strict'
import { readTexture } from './png.mjs'

export async function verifyBcTextures(manifest, output, method, storage) {
  const mask = await readTexture(manifest, output, 'InlineBC4', method)
  assert.deepEqual([mask.entry.textureEncoding, mask.entry.textureColorSpace, mask.entry.textureStorage],
    ['bc4', 'linear', 'inline'])
  assert.deepEqual(mask.pixel(3, 3), [157, 157, 157, 255])
  assert.deepEqual(mask.pixel(7, 0), [255, 255, 255, 255])

  const channels = await readTexture(manifest, output, 'InlineBC5', method)
  assert.deepEqual([channels.entry.textureEncoding, channels.entry.textureColorSpace, channels.entry.textureStorage],
    ['bc5', 'linear', 'inline'])
  assert.deepEqual(channels.pixel(3, 3), [157, 98, 0, 255])
  assert.deepEqual(channels.pixel(7, 0), [255, 60, 0, 255])

  const color = await readTexture(manifest, output, 'InlineBC7', method)
  assert.deepEqual([color.entry.textureEncoding, color.entry.textureColorSpace, color.entry.textureStorage],
    ['bc7', 'srgb', 'inline'])
  assert.deepEqual(color.pixel(0, 0), [34, 88, 152, 180])
  assert.deepEqual(color.pixel(7, 3), [92, 44, 126, 78])

  const streamed = await readTexture(manifest, output, 'StreamedBC7', method)
  assert.deepEqual([streamed.entry.textureEncoding, streamed.entry.textureColorSpace, streamed.entry.textureStorage],
    ['bc7', 'linear', storage])
  assert.deepEqual([streamed.entry.width, streamed.entry.height], [512, 512])
  for (const [actual, expected] of [
    [streamed.pixel(20, 20), [0, 255, 0, 204]], [streamed.pixel(20, 490), [255, 0, 0, 51]],
  ]) assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]) <= 8), String(actual))
}
