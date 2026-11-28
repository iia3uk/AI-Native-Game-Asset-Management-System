import { sourceMeshHeaders } from './unreal-source-mesh.mjs'

function editorFixture(build) {
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
  const { imports: importRows, objects } = build({ i32, name, tag, struct, array, none, object, enumValue, bool, streaming })
  const imports = Buffer.concat(importRows.map(([type, label, owner = 0]) =>
    Buffer.concat([none, name(type), i32(owner), name(label), none])))
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
  const summary = sourceMeshHeaders().bytes.subarray(0, 220)
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
  summary.writeInt32LE(objects.length, 76)
  summary.writeInt32LE(exportAt, 80)
  summary.writeInt32LE(imports.length / 36, 84)
  summary.writeInt32LE(importAt, 88)
  summary.writeInt32LE(start, 92)
  summary.writeBigInt64LE(BigInt(end), 196)
  return Buffer.concat([summary, table, imports, exports, ...payloads, Buffer.from('c1832a9e', 'hex')])
}

const texture = '/Game/Example/T_Colors'

export function sourceMaterialFixture({ badObject = false, uv = 0, entries = 1 } = {}) {
  return editorFixture(({ i32, name, tag, struct, array, none, object, enumValue, streaming }) => {
    const info = struct('ParameterInfo', 'MaterialParameterInfo', Buffer.concat([
      tag('Name', 'NameProperty', name('BaseColor')),
      enumValue('Association', 'EMaterialParameterAssociation', 'GlobalParameter'),
      tag('Index', 'IntProperty', i32(-1)), none,
    ]))
    const serialized = Buffer.concat([
      object('Parent', -3),
      array('TextureParameterValues', 'TextureParameterValue', entries,
        Buffer.concat([info, object('ParameterValue', -5), none])),
      streaming(texture, uv), none,
    ])
    return { imports: [
      ['Class', 'MaterialInstanceConstant', -2], ['Package', '/Script/Engine'],
      ['Material', 'M_Master', -4], ['Package', '/Game/Example/M_Master'],
      [badObject ? 'Material' : 'Texture2D', 'T_Colors', -6], ['Package', texture],
    ], objects: [[-1, 'MI_Example', 0, serialized]] }
  })
}

export function sourceNormalGraph({ tangent = true, customCoordinates = false, uv = 0, classOwner = 1 } = {}) {
  return editorFixture(({ name, tag, struct, none, object, enumValue, bool, streaming }) => {
    const input = Buffer.alloc(52)
    input.writeInt32LE(2)
    for (const offset of [16, 20, 24, 28]) input.writeInt32LE(1, offset)
    const material = Buffer.concat([struct('Normal', 'VectorMaterialInput', input), bool('bTangentSpaceNormal', tangent),
      streaming(texture, uv), none])
    const sample = Buffer.concat([
      tag('ParameterName', 'NameProperty', name('SurfaceDetail')), object('Texture', -4), object('Material', 1),
      enumValue('SamplerType', 'EMaterialSamplerType', 'SAMPLERTYPE_Normal'),
      ...(customCoordinates ? [struct('Coordinates', 'ExpressionInput', Buffer.alloc(36))] : []), none,
    ])
    return { imports: [
      ['Class', 'Material', -2], ['Package', '/Script/Engine'], ['Class', 'MaterialExpressionTextureSampleParameter2D', -2],
      ['Texture2D', 'T_Colors', -5], ['Package', texture],
    ], objects: [[-1, 'M_Master', 0, material], [-3, 'TextureSample', classOwner, sample]] }
  })
}

export function sourceNormalTexture({ flip, srgb = false, png }) {
  return editorFixture(({ none, enumValue, bool }) => {
    const properties = Buffer.concat([
      enumValue('CompressionSettings', 'TextureCompressionSettings', 'TC_Normalmap'), bool('SRGB', srgb),
      ...(flip === undefined ? [] : [bool('bFlipGreenChannel', flip)]), none, png,
    ])
    return { imports: [['Class', 'Texture2D', -2], ['Package', '/Script/Engine']],
      objects: [[-1, 'T_Colors', 0, properties]] }
  })
}
