const magic = Buffer.from('c1832a9e', 'hex')
const int = value => {
  const bytes = Buffer.alloc(4)
  bytes.writeInt32LE(value)
  return bytes
}
const float = value => {
  const bytes = Buffer.alloc(4)
  bytes.writeFloatLE(value)
  return bytes
}
const ints = (...values) => Buffer.concat(values.map(int))
const floats = (...values) => Buffer.concat(values.map(float))
const bulk = (stride, items) => Buffer.concat([ints(stride, items.length / stride), items])
const string = name => Buffer.concat([int(Buffer.byteLength(name) + 1), Buffer.from(name + '\0')])

function lod(vertices, indices, sections, { wide = false, invalidIndex = false, external = false } = {}) {
  const xyz = floats(...vertices.flatMap(row => row.slice(0, 3)))
  const texture = floats(...vertices.flatMap(row => row.slice(3)))
  const normals = Buffer.concat(vertices.map(() => Buffer.from([127, 0, 0, 0, 0, 0, 127, 127])))
  const colors = Buffer.concat(vertices.map((_, i) => Buffer.from([40, 80, 100 + i, 255])))
  const values = [...indices]
  if (invalidIndex) values[0] = vertices.length
  const indexBytes = Buffer.alloc(values.length * (wide ? 4 : 2))
  for (const [i, value] of values.entries()) {
    if (wide) indexBytes.writeUInt32LE(value, i * 4)
    else indexBytes.writeUInt16LE(value, i * 2)
  }
  const buffers = Buffer.concat([
    Buffer.from([1, 13]), ints(12, vertices.length), bulk(12, xyz),
    Buffer.from([1, 0]), ints(2, vertices.length, 1, 0), bulk(8, normals), bulk(8, texture),
    Buffer.from([1, 0]), ints(4, vertices.length), bulk(4, colors),
    int(Number(wide)), bulk(1, indexBytes), int(0), ints(0, 1, 0, 0),
    Buffer.alloc((sections.length + 1) * 12),
  ])
  const exportData = Buffer.concat([
    Buffer.from([1, 0]), int(sections.length),
    ...sections.map(([slot, start, triangles]) => ints(slot, start, triangles, 0, vertices.length - 1, 1, 1, 0, 1)),
    float(0), ints(0, Number(!external)),
    ...(external ? [ints(0x101, buffers.length, buffers.length, 0, 0), Buffer.alloc(88)] : [buffers]),
    ints(buffers.length, 0, 0),
  ])
  return { exportData, ...(external && { bulkData: buffers }) }
}

export function cookedStaticMesh({ name, split = true, rootClass = '/Script/Engine', invalidIndex = false, external = false }) {
  const names = new Map()
  const fname = name => {
    if (!names.has(name)) names.set(name, names.size)
    return ints(names.get(name), 0)
  }
  const points = [[0, 0, 0, 0, 0, 0.25, 0.75], [0, 100, 0, 0, 1, 0.5, 1],
    [200, 0, 0, 1, 0, 1, 0], [200, 100, 0, 1, 1, 0.75, 0.25]]
  const primary = lod(points, [0, 1, 2, 2, 1, 3], [[1, 0, 1], [0, 3, 1]], { invalidIndex })
  const secondary = lod(points.slice(0, 3), [0, 1, 2], [[0, 0, 1]], { wide: true, external })
  const exportData = Buffer.concat([
    fname('None'), int(0), Buffer.from([1, 0]), ints(1, 0, 0), Buffer.alloc(16), int(0),
    int(2), primary.exportData, secondary.exportData,
    Buffer.from([2, 1, 1]), floats(100, 50, 0, 100, 50, 0, 112),
    int(1), ...[1, 0.45, 0, 0, 0, 0, 0, 0].map(size => Buffer.concat([int(1), float(size)])),
    ints(0, 0, 2), int(-3), fname('Paint'), Buffer.alloc(24),
    int(0), fname('Trim'), Buffer.alloc(24),
  ])
  const imports = [['Class', 'StaticMesh', -2], ['Package', rootClass, 0],
    ['MaterialInstanceConstant', 'MI_Panel', -4], ['Package', '/Game/Example/MI_Panel', 0]]
  const importTable = Buffer.concat(imports.map(([type, label, outer]) =>
    Buffer.concat([fname('/Script/CoreUObject'), fname(type), int(outer), fname(label)])))
  const object = Buffer.alloc(104)
  object.writeInt32LE(-1)
  fname(name).copy(object, 16)
  const nameTable = Buffer.concat([...names.keys()].map(value => Buffer.concat([string(value), Buffer.alloc(4)])))
  const header = Buffer.alloc(180)
  magic.copy(header)
  header.writeInt32LE(-7, 4)
  header.writeInt32LE(864, 8)
  header.writeInt32LE(522, 12)
  header.writeUInt32LE(0x80000200, 32)
  header.writeInt32LE(names.size, 36)
  header.writeInt32LE(header.length, 40)
  const importAt = header.length + nameTable.length
  const exportAt = importAt + importTable.length
  const dependsAt = exportAt + object.length
  const headerSize = dependsAt + 4
  header.writeInt32LE(headerSize, 24)
  header.writeInt32LE(1, 52)
  header.writeInt32LE(exportAt, 56)
  header.writeInt32LE(imports.length, 60)
  header.writeInt32LE(importAt, 64)
  header.writeInt32LE(dependsAt, 68)
  header.writeBigInt64LE(BigInt(headerSize + exportData.length), 156)
  object.writeBigInt64LE(BigInt(exportData.length), 28)
  object.writeBigInt64LE(BigInt(headerSize), 36)
  const tables = [header, nameTable, importTable, object, int(0)]
  return [
    { path: name + '.uasset', content: Buffer.concat(split ? tables : [...tables, exportData, magic]) },
    ...(split ? [{ path: name + '.uexp', content: Buffer.concat([exportData, magic]) }] : []),
    ...(secondary.bulkData ? [{ path: name + '.ubulk', content: secondary.bulkData }] : []),
  ]
}
