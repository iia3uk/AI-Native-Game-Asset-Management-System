import { taggedProperties } from '../editor-package/properties.mjs'
import { importedGameObject } from '../editor-package/references.mjs'

const texture2d = new Set(['Texture2D'])
const sampleTypes = new Set(['MaterialExpressionTextureSample', 'MaterialExpressionTextureSampleParameter2D'])
const sampleSettings = new Set(['Texture', 'SamplerType', 'Material', 'ParameterName', 'ExpressionGUID', 'Desc',
  'MaterialExpressionEditorX', 'MaterialExpressionEditorY', 'MaterialExpressionGuid', 'bCollapsed'])

export function directNormalInput(bytes, table, material, properties) {
  const input = properties.get('Normal')
  const tangentSpace = properties.get('bTangentSpaceNormal')
  const attributes = properties.get('bUseMaterialAttributes')
  if (input?.type !== 'StructProperty' || input.inner !== 'VectorMaterialInput' || input.size !== 52 ||
      (tangentSpace && (tangentSpace.type !== 'BoolProperty' || tangentSpace.size !== 0 || tangentSpace.value !== 1)) ||
      (attributes && (attributes.type !== 'BoolProperty' || attributes.size !== 0 || attributes.value !== 0)) ||
      properties.has('CustomizedUVs')) return null
  const at = input.start
  // The stock VectorMaterialInput stores expression index, RGB output, mask and UseConstant.
  const rgb = [0, 1, 1, 1, 1, 0, 0]
  if (![4, 16, 20, 24, 28, 32, 36].every((offset, index) => bytes.readInt32LE(at + offset) === rgb[index])) return null
  const sample = table.exported(bytes.readInt32LE(at))
  if (sample?.outer !== material.index || !sampleTypes.has(sample.type)) return null
  const { properties: fields } = taggedProperties(bytes, sample.start, sample.end, table.nameAt)
  if ([...fields.keys()].some(key => !sampleSettings.has(key))) return null
  const sampler = fields.get('SamplerType')
  const texture = fields.get('Texture')
  const owner = fields.get('Material')
  if (sampler?.type !== 'ByteProperty' || sampler.inner !== 'EMaterialSamplerType' || sampler.size !== 8 ||
      table.nameAt(sampler.start) !== 'SAMPLERTYPE_Normal' || texture?.type !== 'ObjectProperty' || texture.size !== 4 ||
      owner?.type !== 'ObjectProperty' || owner.size !== 4 || bytes.readInt32LE(owner.start) !== material.index) return null
  const path = importedGameObject(table.imported, bytes.readInt32LE(texture.start), texture2d)
  if (sample.type === 'MaterialExpressionTextureSample') return path && { path }
  const parameter = fields.get('ParameterName')
  if (parameter?.type !== 'NameProperty' || parameter.size !== 8) return null
  const name = table.nameAt(parameter.start)
  return name !== 'None' && name.length <= 256 ? { path, parameter: name } : null
}
