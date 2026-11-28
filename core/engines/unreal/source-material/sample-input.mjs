import { taggedProperties } from '../editor-package/properties.mjs'
import { importedGameObject } from '../editor-package/references.mjs'

const texture2d = new Set(['Texture2D'])
const sampleTypes = new Set(['MaterialExpressionTextureSample', 'MaterialExpressionTextureSampleParameter2D'])
const sampleSettings = new Set(['Texture', 'SamplerType', 'Material', 'ParameterName', 'ExpressionGUID', 'Desc',
  'MaterialExpressionEditorX', 'MaterialExpressionEditorY', 'MaterialExpressionGuid', 'bCollapsed'])
const swizzles = new Map([[0, [1, 1, 1, 1, 0, 'rgb']], [4, [1, 0, 0, 0, 1, 'alpha']]])

export function sampleChannel(bytes, input) {
  if (!input || input.size < 36) return null
  const swizzle = swizzles.get(bytes.readInt32LE(input.start + 4))
  return swizzle && [16, 20, 24, 28, 32].every((offset, index) =>
    bytes.readInt32LE(input.start + offset) === swizzle[index]) ? swizzle[5] : null
}

export function usesMeshUv0(properties) {
  const attributes = properties.get('bUseMaterialAttributes')
  return (!attributes || (attributes.type === 'BoolProperty' && attributes.size === 0 && attributes.value === 0)) &&
    !properties.has('CustomizedUVs')
}

export function expressionFields(bytes, table, sample) {
  return taggedProperties(bytes, sample.start, sample.end, table.nameAt).properties
}

export function readTextureSample(bytes, table, material, sample) {
  if (sample?.outer !== material.index || !sampleTypes.has(sample.type)) return null
  const fields = expressionFields(bytes, table, sample)
  if ([...fields.keys()].some(key => !sampleSettings.has(key))) return null
  const sampler = fields.get('SamplerType')
  const texture = fields.get('Texture')
  const owner = fields.get('Material')
  if ((sampler && (sampler.type !== 'ByteProperty' || sampler.inner !== 'EMaterialSamplerType' || sampler.size !== 8)) ||
      texture?.type !== 'ObjectProperty' || texture.size !== 4 || owner?.type !== 'ObjectProperty' || owner.size !== 4 ||
      bytes.readInt32LE(owner.start) !== material.index) return null
  const path = importedGameObject(table.imported, bytes.readInt32LE(texture.start), texture2d)
  const sampleType = sampler ? table.nameAt(sampler.start) : 'SAMPLERTYPE_Color'
  if (sample.type === 'MaterialExpressionTextureSample') return path && { path, sampleType }
  const parameter = fields.get('ParameterName')
  if (parameter?.type !== 'NameProperty' || parameter.size !== 8) return null
  const name = table.nameAt(parameter.start)
  return name !== 'None' && name.length <= 256 ? { path, parameter: name, sampleType } : null
}
