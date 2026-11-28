import { sourceMeshHeaders } from './unreal-source-mesh.mjs'

export function editorFixture(build, { legacy = false } = {}) {
  const names = new Map([['None', 0]])
  const i32 = value => {
    const bytes = Buffer.alloc(4)
    bytes.writeInt32LE(value)
    return bytes
  }
  function name(value) {
    if (!names.has(value)) names.set(value, names.size)
    return Buffer.concat([i32(names.get(value)), i32(0)])
  }
  function tag(label, type, data, metadata = Buffer.alloc(0)) {
    return Buffer.concat([name(label), name(type), i32(data.length), i32(0), metadata, Buffer.alloc(1), data])
  }
  const none = name('None')
  const struct = (label, type, data) => tag(label, 'StructProperty', data, Buffer.concat([name(type), Buffer.alloc(16)]))
  const array = (label, type, count, data) => tag(label, 'ArrayProperty',
    Buffer.concat([i32(count), struct(label, type, data)]), name('StructProperty'))
  const object = (label, index) => tag(label, 'ObjectProperty', i32(index))
  const enumValue = (label, type, value) => tag(label, 'ByteProperty', name(value), name(type))
  const bool = (label, value) => tag(label, 'BoolProperty', Buffer.alloc(0), Buffer.from([Number(value)]))
  function streaming(path, uv) {
    const asset = path.split('/').at(-1)
    return array('TextureStreamingData', 'MaterialTextureInfo', 1, Buffer.concat([
      struct('TextureReference', 'SoftObjectPath', Buffer.concat([name(path + '.' + asset), i32(0)])),
      tag('UVChannelIndex', 'IntProperty', i32(uv)), none,
    ]))
  }
  const { imports: importRows, objects, bulk = Buffer.alloc(0) } = build({ i32, name, tag, struct, array, none, object, enumValue, bool, streaming })
  const imports = Buffer.concat(importRows.map(([type, label, owner = 0]) =>
    Buffer.concat([none, name(type), i32(owner), name(label), ...(legacy ? [] : [none])])))
  const exports = Buffer.alloc(104 * objects.length)
  for (const [index, [type, label, owner]] of objects.entries()) {
    const at = index * 104
    exports.writeInt32LE(type, at)
    exports.writeInt32LE(owner, at + 12)
    name(label).copy(exports, at + 16)
  }
  const table = Buffer.concat([...names.keys()].map(value => Buffer.concat([
    i32(Buffer.byteLength(value) + 1), Buffer.from(value), Buffer.alloc(5),
  ])))
  const modernSummary = sourceMeshHeaders().bytes.subarray(0, 220)
  // This UE4 layout predates the localization ID and persistent package GUID.
  const summary = legacy ? Buffer.concat([modernSummary.subarray(0, 68), modernSummary.subarray(72, 128),
    modernSummary.subarray(144)]) : modernSummary
  const importAt = summary.length + table.length
  const exportAt = importAt + imports.length
  const start = exportAt + exports.length
  let end = start
  const payloads = objects.map((row, index) => {
    const data = row[3]
    exports.writeBigInt64LE(BigInt(data.length), index * 104 + 28)
    exports.writeBigInt64LE(BigInt(end), index * 104 + 36)
    end += data.length
    return data
  })
  summary.writeInt32LE(start, 44)
  summary.writeInt32LE(names.size, 56)
  summary.writeInt32LE(summary.length, 60)
  const exportsAt = legacy ? 72 : 76
  summary.writeInt32LE(objects.length, exportsAt)
  summary.writeInt32LE(exportAt, exportsAt + 4)
  summary.writeInt32LE(importRows.length, exportsAt + 8)
  summary.writeInt32LE(importAt, exportsAt + 12)
  summary.writeInt32LE(start, exportsAt + 16)
  summary.writeBigInt64LE(BigInt(end), legacy ? 176 : 196)
  if (legacy) {
    summary.writeInt32LE(514, 12)
    summary.writeInt32LE(20, 40)
  }
  return Buffer.concat([summary, table, imports, exports, ...payloads, bulk, Buffer.from('c1832a9e', 'hex')])
}
