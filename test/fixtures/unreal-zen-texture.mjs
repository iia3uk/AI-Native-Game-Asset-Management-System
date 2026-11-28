const words = (...values) => {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4))
  return bytes
}

const long = value => {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(BigInt(value))
  return bytes
}

const nil = 0xffffffffffffffffn
const engineTexture = 0x5b93bca796d1fa6fn
export const zenFixtureId = 0x0cdfc36a01bb2f9dn
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

export function zenTexturePackage({ mode }) {
  const external = mode !== 'inline'
  const format = 'PF_B8G8R8A8'
  const names = ['/Game/Verification/Sample', 'Sample', 'None', format, 'SRGB', 'BoolProperty']
  const name = value => words(names.indexOf(value), 0)
  const strings = names.map(value => Buffer.from(value))
  const stringBytes = Buffer.concat(strings)
  const nameMap = Buffer.concat([words(names.length, stringBytes.length), long(0xc1640000),
    Buffer.alloc(8 * names.length), Buffer.from(strings.flatMap(string => [0, string.length])), stringBytes])
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
  const version = words(3, 522, external ? 1012 : 1009, 0, 0)
  const paddingSize = (8 - (52 + version.length + nameMap.length) % 8) % 8
  const bulkHeader = Buffer.concat([...(external ? [long(paddingSize), Buffer.alloc(paddingSize)] : []), long(bulkMap.length), bulkMap])
  const imports = 52 + version.length + nameMap.length + bulkHeader.length
  const exportAt = imports + 8
  const exportTable = Buffer.concat([long(0), long(object.length), name('Sample'), long(nil), long(engineTexture),
    long(nil), long(nil), long(0), words(3, 0)])
  const bundles = exportAt + exportTable.length
  const dependencies = bundles + 16
  const packageNames = dependencies + 20
  const end = packageNames + 4
  const header = words(1, end, 0, 0, 0x80000200, end, imports, imports, exportAt, bundles, dependencies, packageNames, packageNames)
  return {
    asset: Buffer.concat([header, version, nameMap, bulkHeader, long(engineTexture), exportTable, words(0, 0, 0, 1),
      words(0xffffffff, 0, 0, 0, 0), words(0), object]),
    bulk: Buffer.concat([padding, pixels]),
  }
}
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
