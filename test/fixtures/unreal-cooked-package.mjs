const int = value => {
  const bytes = Buffer.alloc(4)
  bytes.writeInt32LE(value)
  return bytes
}
const magic = Buffer.from('c1832a9e', 'hex')

export function cookedPackageFixture(build, { split = true } = {}) {
  const names = new Map()
  const name = value => {
    if (!names.has(value)) names.set(value, names.size)
    return Buffer.concat([int(names.get(value)), int(0)])
  }
  const none = name('None')
  const object = (label, index) => Buffer.concat([name(label), name('ObjectProperty'), int(4), int(0), Buffer.alloc(1), int(index)])
  const { imports, objects: [[type, label, owner, data]] } = build({ i32: int, name, none, object })
  const inputTable = Buffer.concat(imports.map(([type, label, outer = 0]) =>
    Buffer.concat([name('/Script/CoreUObject'), name(type), int(outer), name(label)])))
  const entry = Buffer.alloc(104)
  entry.writeInt32LE(type, 0)
  entry.writeInt32LE(owner, 12)
  name(label).copy(entry, 16)
  const namesTable = Buffer.concat([...names.keys()].map(value =>
    Buffer.concat([int(Buffer.byteLength(value) + 1), Buffer.from(value), Buffer.alloc(5)])))
  const header = Buffer.alloc(180)
  magic.copy(header)
  header.writeInt32LE(-7, 4)
  header.writeInt32LE(864, 8)
  header.writeInt32LE(522, 12)
  header.writeUInt32LE(0x80000200, 32)
  header.writeInt32LE(names.size, 36)
  header.writeInt32LE(header.length, 40)
  const inputAt = header.length + namesTable.length
  const exportAt = inputAt + inputTable.length
  const dependsAt = exportAt + entry.length
  const headerSize = dependsAt + 4
  header.writeInt32LE(headerSize, 24)
  header.writeInt32LE(1, 52)
  header.writeInt32LE(exportAt, 56)
  header.writeInt32LE(imports.length, 60)
  header.writeInt32LE(inputAt, 64)
  header.writeInt32LE(dependsAt, 68)
  header.writeBigInt64LE(BigInt(headerSize + data.length), 156)
  entry.writeBigInt64LE(BigInt(data.length), 28)
  entry.writeBigInt64LE(BigInt(headerSize), 36)
  const tables = [header, namesTable, inputTable, entry, int(0)]
  return {
    uasset: Buffer.concat(split ? tables : [...tables, data, magic]),
    ...(split && { uexp: Buffer.concat([data, magic]) }),
  }
}
