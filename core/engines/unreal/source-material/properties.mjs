import { editorPackage, requireLayout } from '../editor-package/tables.mjs'
import { structArray, taggedProperties } from '../editor-package/properties.mjs'
import { importedGameObject, importedPackageObject, softGameObject, softPackageObject } from '../editor-package/references.mjs'
import { directNormalInput } from './normal-input.mjs'
import { readMaterialSurface } from './surface-input.mjs'

export const sourceMaterialRevision = 4
export const sourceMaterialVersions = new Set([514, 522])
export const materialClasses = new Set(['Material', 'MaterialInstanceConstant'])
const textures = new Set(['Texture2D'])
const cookedTextures = new Set(['Texture2D', 'Texture2DArray', 'TextureCube', 'VolumeTexture', 'VirtualTexture2D'])

function matches(field, type, size, inner = null) {
  return field?.type === type && field.size === size && field.inner === inner
}

function floatAt(bytes, offset) {
  const value = bytes.readFloatLE(offset)
  requireLayout(Number.isFinite(value))
  return value
}

function parameterInfo(bytes, nameAt, field, cooked) {
  requireLayout(field?.type === 'StructProperty' && field.inner === 'MaterialParameterInfo')
  const { properties, end } = taggedProperties(bytes, field.start, field.end, nameAt)
  const name = properties.get('Name')
  const association = properties.get('Association')
  const index = properties.get('Index')
  const hasIndex = matches(index, 'IntProperty', 4)
  const hasAssociation = matches(association, 'ByteProperty', 8, 'EMaterialParameterAssociation') ||
    (cooked && matches(association, 'EnumProperty', 8, 'EMaterialParameterAssociation'))
  requireLayout(end === field.end && matches(name, 'NameProperty', 8) &&
    (hasIndex || (cooked && !index)) && (hasAssociation || (cooked && !association)))
  const value = nameAt(name.start)
  requireLayout(value !== 'None' && value.length <= 256)
  const layer = hasIndex ? bytes.readInt32LE(index.start) : null
  const scope = hasAssociation ? nameAt(association.start) : layer === -1 ? 'GlobalParameter' : null
  return { name: value, association: scope, index: layer ?? (scope === 'GlobalParameter' ? -1 : null) }
}

function legacyParameterInfo(nameAt, row) {
  const field = row.get('ParameterName')
  requireLayout(!row.has('ParameterInfo') && matches(field, 'NameProperty', 8))
  const name = nameAt(field.start)
  requireLayout(name !== 'None' && name.length <= 256)
  return { name, association: 'GlobalParameter', index: -1 }
}

function parameters(kind, bytes, table, properties, cooked) {
  const field = properties.get(kind + 'ParameterValues')
  if (!field) return []
  const { nameAt, imported } = table
  return structArray(bytes, field, nameAt, kind + 'ParameterValue').map(row => {
    const info = table.layout.fileVersionUE4 === 514 ? legacyParameterInfo(nameAt, row) :
      parameterInfo(bytes, nameAt, row.get('ParameterInfo'), cooked)
    const data = row.get('ParameterValue')
    if (!data) return info // The serialized default can be omitted, so keep the override unresolved.
    if (kind === 'Texture') {
      requireLayout(matches(data, 'ObjectProperty', 4))
      const object = bytes.readInt32LE(data.start)
      const path = cooked ? importedPackageObject(imported, object, cookedTextures) : importedGameObject(imported, object, textures)
      return { ...info, path, status: path ? 'reference' : object ? 'unsupported-reference' : 'empty' }
    }
    if (kind === 'Scalar') {
      requireLayout(matches(data, 'FloatProperty', 4))
      return { ...info, value: floatAt(bytes, data.start) }
    }
    requireLayout(matches(data, 'StructProperty', 16, 'LinearColor'))
    return { ...info, value: [0, 4, 8, 12].map(offset => floatAt(bytes, data.start + offset)) }
  })
}

function streamingData(bytes, nameAt, field, graph) {
  if (!field) return []
  return structArray(bytes, field, nameAt, 'MaterialTextureInfo').map(row => {
    const texture = row.get('TextureReference')
    const name = row.get('TextureName')
    const channel = row.get('UVChannelIndex')
    const scale = row.get('SamplingScale')
    const path = matches(texture, 'StructProperty', 12, 'SoftObjectPath') && bytes.readInt32LE(texture.start + 8) === 0 ?
      (graph ? softGameObject : softPackageObject)(nameAt(texture.start)) : null
    return { path, ...(!graph && matches(name, 'NameProperty', 8) && { textureName: nameAt(name.start) }),
      uvChannel: matches(channel, 'IntProperty', 4) ? bytes.readInt32LE(channel.start) : null,
      samplingScale: matches(scale, 'FloatProperty', 4) ? floatAt(bytes, scale.start) : null }
  })
}

export function readSourceMaterial(bytes, version = 522) {
  if (!sourceMaterialVersions.has(version)) return null
  const table = editorPackage(bytes, version)
  const object = table?.topLevel(materialClasses)
  return object ? readMaterialProperties(bytes, table, object) : null
}

export function readMaterialProperties(bytes, table, object, { graph = true } = {}) {
  const { properties } = taggedProperties(bytes, object.start, object.end, table.nameAt)
  const parent = properties.get('Parent')
  if (parent) requireLayout(matches(parent, 'ObjectProperty', 4))
  const reference = graph ? importedGameObject : importedPackageObject
  const parentPath = parent ? reference(table.imported, bytes.readInt32LE(parent.start), materialClasses) : null
  return {
    type: object.type,
    parent: parentPath,
    parentStatus: object.type === 'Material' ? 'base' : parentPath ? 'reference' : 'unresolved',
    textures: parameters('Texture', bytes, table, properties, !graph),
    scalars: parameters('Scalar', bytes, table, properties, !graph),
    vectors: parameters('Vector', bytes, table, properties, !graph),
    streaming: streamingData(bytes, table.nameAt, properties.get('TextureStreamingData'), graph),
    normalInput: graph && object.type === 'Material' ? directNormalInput(bytes, table, object, properties) : null,
    surface: readMaterialSurface(bytes, table, object, properties, graph),
  }
}
