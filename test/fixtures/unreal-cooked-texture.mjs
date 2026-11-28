export const i32 = value => {
  const result = Buffer.alloc(4)
  result.writeInt32LE(value)
  return result
}
export const i64 = value => {
  const result = Buffer.alloc(8)
  result.writeBigInt64LE(BigInt(value))
  return result
}
const FString = value => Buffer.concat([i32(Buffer.byteLength(value) + 1), Buffer.from(value + '\0')])
const magic = Buffer.from('c1832a9e', 'hex')

// A versioned, editor-stripped UE4.27 package with one native export.
export function cookedObject({ name, type, extraNames, serialize, sidecars = [],
  split = true, rootClass = '/Script/Engine' }) {
  const names = ['None', 'Class', 'Package', '/Script/CoreUObject', rootClass, type, name, ...extraNames]
  const fname = value => Buffer.concat([i32(names.indexOf(value)), i32(0)])
  const namesBytes = Buffer.concat(names.map(value => Buffer.concat([FString(value), Buffer.alloc(4)])))
  const imports = Buffer.concat([
    fname('/Script/CoreUObject'), fname('Class'), i32(-2), fname(type),
    fname('/Script/CoreUObject'), fname('Package'), i32(0), fname(rootClass),
  ])
  const object = Buffer.alloc(104)
  object.writeInt32LE(-1)
  fname(name).copy(object, 16)
  const depends = i32(0)
  const header = Buffer.alloc(180)
  magic.copy(header)
  header.writeInt32LE(-7, 4)
  header.writeInt32LE(864, 8)
  header.writeInt32LE(522, 12)
  header.writeUInt32LE(0x80000200, 32)
  header.writeInt32LE(names.length, 36)
  header.writeInt32LE(header.length, 40)
  const importAt = header.length + namesBytes.length
  const exportAt = importAt + imports.length
  const dependsAt = exportAt + object.length
  const headerSize = dependsAt + depends.length
  header.writeInt32LE(headerSize, 24)
  header.writeInt32LE(1, 52)
  header.writeInt32LE(exportAt, 56)
  header.writeInt32LE(2, 60)
  header.writeInt32LE(importAt, 64)
  header.writeInt32LE(dependsAt, 68)

  const exportData = serialize(fname, headerSize)
  object.writeBigInt64LE(BigInt(exportData.length), 28)
  object.writeBigInt64LE(BigInt(headerSize), 36)
  header.writeBigInt64LE(BigInt(headerSize + exportData.length), 156)

  const tables = [header, namesBytes, imports, object, depends]
  return [
    { path: name + '.uasset', content: Buffer.concat(split ? tables : [...tables, exportData, magic]) },
    ...(split ? [{ path: name + '.uexp', content: Buffer.concat([exportData, magic]) }] : []),
    ...sidecars,
  ]
}

export function cookedTexture({ name, format, width, height, pixels, external = false, normalMap = false, srgb, ...options }) {
  const normalNames = ['CompressionSettings', 'ByteProperty', 'TextureCompressionSettings', 'TC_Normalmap']
  const srgbNames = typeof srgb === 'boolean' ? ['SRGB', 'BoolProperty'] : []
  return cookedObject({ name, type: 'Texture2D', extraNames: [format, ...(normalMap ? normalNames : []), ...srgbNames], ...options,
    sidecars: external ? [{ path: name + '.ubulk', content: pixels }] : [],
    serialize(fname, headerSize) {
      const texture = Buffer.concat([
        i32(width), i32(height), i32(1), FString(format), i32(0), i32(1),
        i32(1), i32(external ? 0x101 : 0x40), i32(pixels.length), i32(pixels.length), i64(0),
        ...(external ? [] : [pixels]), i32(width), i32(height), i32(1), i32(0),
      ])
      const tags = normalMap ? [fname(normalNames[0]), fname(normalNames[1]), i32(8), i32(0),
        fname(normalNames[2]), Buffer.alloc(1), fname(normalNames[3])] : []
      if (srgbNames.length) tags.push(fname('SRGB'), fname('BoolProperty'), i32(0), i32(0), Buffer.from([Number(srgb), 0]))
      const start = Buffer.concat([...tags, fname('None'), i32(0), Buffer.from([1, 0, 1, 0]), i32(1), fname(format)])
      return Buffer.concat([start, i64(headerSize + start.length + 8 + texture.length), texture, fname('None')])
    },
  })
}
