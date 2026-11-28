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
const fstring = value => Buffer.concat([int(Buffer.byteLength(value) + 1), Buffer.from(value + '\0')])
const magic = Buffer.from('c1832a9e', 'hex')

export function cookedMaterial({ name, parent, textures = [], scalars = [], vectors = [], split = true, malformed = false,
  rootClass = '/Script/Engine' }) {
  const names = new Map()
  const fname = value => {
    if (!names.has(value)) names.set(value, names.size)
    return Buffer.concat([int(names.get(value)), int(0)])
  }
  const none = fname('None')
  const tag = (label, type, bytes, metadata = Buffer.alloc(0)) =>
    Buffer.concat([fname(label), fname(type), int(bytes.length), int(0), metadata, Buffer.alloc(1), bytes])
  const structure = (label, type, bytes) => tag(label, 'StructProperty', bytes, Buffer.concat([fname(type), Buffer.alloc(16)]))
  const className = parent ? 'MaterialInstanceConstant' : 'Material'
  const imports = [['Class', className, -2], ['Package', rootClass, 0]]
  const addReference = (path, type) => {
    const index = -(imports.length + 1)
    imports.push([type, path.split('/').at(-1), index - 1], ['Package', path, 0])
    return int(index)
  }
  const properties = []
  if (parent) {
    const [path, type = 'Material'] = parent
    properties.push(tag('Parent', 'ObjectProperty', addReference(path, type)))
  }
  for (const [kind, rows] of [['Texture', textures], ['Scalar', scalars], ['Vector', vectors]]) {
    if (!rows.length) continue
    const label = kind + 'ParameterValues'
    const data = rows.map(({ parameter, value, omitAssociation, layer = -1 }) => {
      const info = structure('ParameterInfo', 'MaterialParameterInfo', Buffer.concat([
        tag('Name', 'NameProperty', fname(parameter)),
        ...(omitAssociation ? [] : [tag('Association', 'ByteProperty', fname(layer === -1 ? 'GlobalParameter' : 'LayerParameter'),
          fname('EMaterialParameterAssociation'))]),
        tag('Index', 'IntProperty', int(layer)), none,
      ]))
      const override = kind === 'Texture' ? tag('ParameterValue', 'ObjectProperty', addReference(value, 'Texture2D')) :
        kind === 'Scalar' ? tag('ParameterValue', 'FloatProperty', float(value)) :
          structure('ParameterValue', 'LinearColor', Buffer.concat(value.map(float)))
      return Buffer.concat([info, override, none])
    })
    properties.push(tag(label, 'ArrayProperty', Buffer.concat([
      int(rows.length), structure(label, kind + 'ParameterValue', Buffer.concat(data)),
    ]), fname('StructProperty')))
  }
  const exportData = Buffer.concat([...properties, malformed ? Buffer.from([0, 0, 0]) : none, ...(malformed ? [] : [int(0)])])
  const importTable = Buffer.concat(imports.map(([type, label, outer]) =>
    Buffer.concat([fname('/Script/CoreUObject'), fname(type), int(outer), fname(label)])))
  const object = Buffer.alloc(104)
  object.writeInt32LE(-1)
  fname(name).copy(object, 16)
  const nameTable = Buffer.concat([...names.keys()].map(value => Buffer.concat([fstring(value), Buffer.alloc(4)])))
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
  ]
}
