import { sourceMeshHeaders } from './unreal-source-mesh.mjs'

export function sourceMaterialFixture({ badObject = false, uv = 0, entries = 1 } = {}) {
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
  const info = struct('ParameterInfo', 'MaterialParameterInfo', Buffer.concat([
    tag('Name', 'NameProperty', name('BaseColor')),
    tag('Association', 'ByteProperty', name('GlobalParameter'), name('EMaterialParameterAssociation')),
    tag('Index', 'IntProperty', i32(-1)), none,
  ]))
  const texture = '/Game/Example/T_Colors'
  const serialized = Buffer.concat([
    tag('Parent', 'ObjectProperty', i32(-3)),
    array('TextureParameterValues', 'TextureParameterValue', entries,
      Buffer.concat([info, tag('ParameterValue', 'ObjectProperty', i32(-5)), none])),
    array('TextureStreamingData', 'MaterialTextureInfo', 1, Buffer.concat([
      struct('TextureReference', 'SoftObjectPath', Buffer.concat([name(texture + '.T_Colors'), i32(0)])),
      tag('UVChannelIndex', 'IntProperty', i32(uv)), none,
    ])), none,
  ])

  function importRow(type, object, owner = 0) {
    return Buffer.concat([none, name(type), i32(owner), name(object), none])
  }
  const imports = Buffer.concat([
    importRow('Class', 'MaterialInstanceConstant', -2), importRow('Package', '/Script/Engine'),
    importRow('Material', 'M_Master', -4), importRow('Package', '/Game/Example/M_Master'),
    importRow(badObject ? 'Material' : 'Texture2D', 'T_Colors', -6), importRow('Package', texture),
  ])
  const exports = Buffer.alloc(104)
  exports.writeInt32LE(-1)
  name('MI_Example').copy(exports, 16)
  const table = Buffer.concat([...names.keys()].map(value => Buffer.concat([
    i32(Buffer.byteLength(value) + 1), Buffer.from(value), Buffer.alloc(5),
  ])))
  const summary = sourceMeshHeaders().bytes.subarray(0, 220)
  const importAt = summary.length + table.length
  const exportAt = importAt + imports.length
  const start = exportAt + exports.length
  summary.writeInt32LE(start, 44)
  summary.writeInt32LE(names.size, 56)
  summary.writeInt32LE(exportAt, 80)
  summary.writeInt32LE(imports.length / 36, 84)
  summary.writeInt32LE(importAt, 88)
  summary.writeInt32LE(start, 92)
  summary.writeBigInt64LE(BigInt(start + serialized.length), 196)
  exports.writeBigInt64LE(BigInt(serialized.length), 28)
  exports.writeBigInt64LE(BigInt(start), 36)
  return Buffer.concat([summary, table, imports, exports, serialized, Buffer.from('c1832a9e', 'hex')])
}
