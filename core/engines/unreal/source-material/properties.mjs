import { editorPackage, requireLayout } from '../editor-package/tables.mjs'
import { structArray, taggedProperties } from '../editor-package/properties.mjs'
import { importedGameObject, softGameObject } from '../editor-package/references.mjs'
import { directNormalInput } from './normal-input.mjs'
import { readMaterialSurface } from './surface-input.mjs'

export const sourceMaterialRevision = 3
const materials = new Set(['Material', 'MaterialInstanceConstant'])
const textures = new Set(['Texture2D'])

function matches(field, type, size, inner = null) {
  return field?.type === type && field.size === size && field.inner === inner
}

function floatAt(bytes, offset) {
  const value = bytes.readFloatLE(offset)
  requireLayout(Number.isFinite(value))
  return value
}

function parameterInfo(bytes, nameAt, field) {
  requireLayout(field?.type === 'StructProperty' && field.inner === 'MaterialParameterInfo')
  const { properties, end } = taggedProperties(bytes, field.start, field.end, nameAt)
  const name = properties.get('Name')
  const association = properties.get('Association')
  const index = properties.get('Index')
  requireLayout(end === field.end && matches(name, 'NameProperty', 8) && matches(index, 'IntProperty', 4) &&
    matches(association, 'ByteProperty', 8, 'EMaterialParameterAssociation'))
  const value = nameAt(name.start)
  requireLayout(value !== 'None' && value.length <= 256)
  return { name: value, association: nameAt(association.start), index: bytes.readInt32LE(index.start) }
}

function parameters(kind, bytes, table, properties) {
  const field = properties.get(kind + 'ParameterValues')
  if (!field) return []
  const { nameAt, imported } = table
  return structArray(bytes, field, nameAt, kind + 'ParameterValue').map(row => {
    const info = parameterInfo(bytes, nameAt, row.get('ParameterInfo'))
    const data = row.get('ParameterValue')
    if (!data) return info // The serialized default can be omitted, so keep the override unresolved.
    if (kind === 'Texture') {
      requireLayout(matches(data, 'ObjectProperty', 4))
      const object = bytes.readInt32LE(data.start)
      const path = importedGameObject(imported, object, textures)
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

function streamingData(bytes, nameAt, field) {
  if (!field) return []
  return structArray(bytes, field, nameAt, 'MaterialTextureInfo').map(row => {
    const texture = row.get('TextureReference')
    const channel = row.get('UVChannelIndex')
    const scale = row.get('SamplingScale')
    const path = matches(texture, 'StructProperty', 12, 'SoftObjectPath') && bytes.readInt32LE(texture.start + 8) === 0 ?
      softGameObject(nameAt(texture.start)) : null
    return { path, uvChannel: matches(channel, 'IntProperty', 4) ? bytes.readInt32LE(channel.start) : null,
      samplingScale: matches(scale, 'FloatProperty', 4) ? floatAt(bytes, scale.start) : null }
  })
}

export function readSourceMaterial(bytes) {
  const table = editorPackage(bytes)
  const object = table?.topLevel(materials)
  if (!object) return null
  const { properties } = taggedProperties(bytes, object.start, object.end, table.nameAt)
  const parent = properties.get('Parent')
  if (parent) requireLayout(matches(parent, 'ObjectProperty', 4))
  const parentPath = parent ? importedGameObject(table.imported, bytes.readInt32LE(parent.start), materials) : null
  return {
    type: object.type,
    parent: parentPath,
    parentStatus: object.type === 'Material' ? 'base' : parentPath ? 'reference' : 'unresolved',
    textures: parameters('Texture', bytes, table, properties),
    scalars: parameters('Scalar', bytes, table, properties),
    vectors: parameters('Vector', bytes, table, properties),
    streaming: streamingData(bytes, table.nameAt, properties.get('TextureStreamingData')),
    normalInput: object.type === 'Material' ? directNormalInput(bytes, table, object, properties) : null,
    surface: readMaterialSurface(bytes, table, object, properties),
  }
}
