import { editorFixture } from './unreal-editor-package.mjs'

function rawArray(values, components, type = 'Float') {
  const width = type === 'UInt8' ? 1 : 4
  const data = Buffer.alloc(4 + values.length * width)
  data.writeInt32LE(values.length / components)
  for (const [index, value] of values.entries()) data['write' + type + (width === 4 ? 'LE' : '')](value, 4 + index * width)
  return data
}

export function rawMeshFixture({ badIndex = false, uv0 = true, partialTangents = false } = {}) {
  const rawVersion = Buffer.alloc(8)
  rawVersion.writeInt32LE(1)
  const repeat = values => Array.from({ length: 6 }, () => values).flat()
  const tangentX = repeat([1, 0, 0])
  if (partialTangents) tangentX[3] = 0
  return Buffer.concat([
    rawVersion,
    rawArray([1, 0], 1, 'Int32'),
    rawArray([0x81234567, 2], 1, 'UInt32'),
    rawArray([0, 0, 0, 100, 0, 0, 0, 100, 0, 100, 100, 0], 3),
    rawArray([0, badIndex ? 99 : 1, 2, 1, 3, 2], 1, 'UInt32'),
    rawArray(tangentX, 3), rawArray(repeat([0, -1, 0]), 3), rawArray(repeat([0, 0, -1]), 3),
    rawArray(uv0 ? [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1] : [], 2),
    rawArray(repeat([0.25, 0.75]), 2),
    ...Array.from({ length: 6 }, () => rawArray([], 2)),
    rawArray(repeat([72, 99, 255, 181]), 4, 'UInt8'),
    rawArray([3, 5], 1, 'Int32'),
  ])
}

export function rawMeshPackageFixture({ payload = rawMeshFixture(), inline = false, version514 = true } = {}) {
  return editorFixture(({ i32, name, struct, array, bool, none }) => {
    const buildScale = Buffer.alloc(12)
    for (const [index, scale] of [2, -3, 0.5].entries()) buildScale.writeFloatLE(scale, index * 4)
    const settings = struct('BuildSettings', 'MeshBuildSettings', Buffer.concat([
      struct('BuildScale3D', 'Vector', buildScale), bool('bGenerateLightmapUVs', true), none,
    ]))
    const materials = [-3, -5].map(index => Buffer.concat([i32(index), name('Shared'), name('Same'),
      Buffer.alloc(24)]))
    const bulkHeader = Buffer.alloc(20)
    bulkHeader.writeInt32LE(inline ? 64 : 1)
    bulkHeader.writeInt32LE(payload.length, 4)
    bulkHeader.writeInt32LE(payload.length, 8)
    const serialized = Buffer.concat([array('SourceModels', 'StaticMeshSourceModel', 2,
      Buffer.concat([settings, none, none])), none, Buffer.alloc(46), bulkHeader,
      ...(inline ? [payload] : []), Buffer.alloc(20), Buffer.alloc(40), i32(0), i32(2), ...materials])
    return { imports: [
      ['Class', 'StaticMesh', -2], ['Package', '/Script/Engine'],
      ['Material', 'M_Top', -4], ['Package', '/Game/Example/M_Top'],
      ['MaterialInstanceConstant', 'MI_Bottom', -6], ['Package', '/Game/Example/MI_Bottom'],
    ], objects: [[-1, 'Fixture', 0, serialized]], ...(inline ? {} : { bulk: payload }) }
  }, { legacy: version514 })
}
