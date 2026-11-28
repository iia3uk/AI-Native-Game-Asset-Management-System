import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { long, words, zenFixtureName, zenName, zenPackage } from './unreal-zen-package.mjs'

const engineTexture = 0x5b93bca796d1fa6fn
export const zenFixtureRgba = Buffer.from([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 30, 40, 50, 100,
])

export function assertZenPng(png, srgb) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [2, 2])
  assert.equal(png.toString('ascii', 37, 41), srgb ? 'sRGB' : 'gAMA')
  if (srgb) assert.equal(png[41], 0)
  else assert.equal(png.readUInt32BE(41), 100000)
  const offset = 49 + png.readUInt32BE(33)
  assert.equal(png.toString('ascii', offset, offset + 4), 'IDAT')
  const data = inflateSync(png.subarray(offset + 4, offset + 4 + png.readUInt32BE(offset - 4)))
  assert.deepEqual(data, Buffer.concat([Buffer.from([0]), zenFixtureRgba.subarray(0, 8),
    Buffer.from([0]), zenFixtureRgba.subarray(8)]))
}

export function zenTexturePackage({ mode, packageName = zenFixtureName, label = 'Sample', publicHash }) {
  const external = mode !== 'inline'
  const format = 'PF_B8G8R8A8'
  const names = [packageName, label, 'None', format, 'SRGB', 'BoolProperty']
  const name = value => zenName(names, value)
  const pixels = Buffer.from(zenFixtureRgba)
  for (let i = 0; i < pixels.length; i += 4) [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]]
  const padding = Buffer.from([12, 34, 56])
  const bulkOffset = mode === 'broken' ? padding.length + 1 : padding.length
  const bulkMap = external ? Buffer.concat([long(bulkOffset), long(0), long(pixels.length), words(0x101, 0)]) : Buffer.alloc(0)
  const formatString = Buffer.from(format + '\0')
  const mip = external ? words(0) : Buffer.concat([words(0x40, pixels.length, pixels.length), long(0), pixels])
  const platform = Buffer.concat([Buffer.alloc(16), words(2, 2, 1, formatString.length), formatString, words(0, 1),
    mip, words(2, 2, 1, 0)])
  const properties = external ? Buffer.concat([Buffer.from([0]), name('SRGB'), name('BoolProperty'), words(0, 0), Buffer.from([0])]) : null
  const object = Buffer.concat([...(properties ? [properties] : []), name('None'), words(0), Buffer.from([1, 0, 1, 0]),
    words(1, 1), name(format), long(8 + platform.length), platform, name('None')])
  return {
    asset: zenPackage({ ue54: external, names, classId: engineTexture, bulkMap, object, label, publicHash }),
    bulk: Buffer.concat([padding, pixels]),
  }
}
