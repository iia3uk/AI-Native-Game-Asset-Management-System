import { taggedProperties } from '../editor-package/properties.mjs'
import { expressionFields, readTextureSample, sampleChannel, usesMeshUv0 } from './sample-input.mjs'

const maskSamplers = new Set(['SAMPLERTYPE_Color', 'SAMPLERTYPE_LinearColor', 'SAMPLERTYPE_Masks',
  'SAMPLERTYPE_Grayscale', 'SAMPLERTYPE_LinearGrayscale'])
const colorBranches = new Map([
  ['MaterialExpressionLinearInterpolate', ['A', 'B']], ['MaterialExpressionMultiply', ['A', 'B']],
  ['MaterialExpressionStaticSwitchParameter', ['A', 'B']], ['MaterialExpressionPower', ['Base']],
])

function bool(field) {
  if (!field) return false
  return field.type === 'BoolProperty' && field.size === 0 && [0, 1].includes(field.value) ? !!field.value : null
}

function surfaceSettings(bytes, nameAt, fields, overrides) {
  const result = {}
  for (const [property, key] of [['BlendMode', 'blend'], ['OpacityMaskClipValue', 'cutoff'], ['TwoSided', 'doubleSided']]) {
    if (overrides) {
      const enabled = bool(fields.get('bOverride_' + property))
      if (enabled === null) return null
      if (!enabled) continue
    }
    const field = fields.get(property)
    if (key === 'blend') {
      result.blend = !field ? 'BLEND_Opaque' : field.type === 'ByteProperty' && field.inner === 'EBlendMode' &&
        field.size === 8 ? nameAt(field.start) : null
    } else if (key === 'cutoff') {
      const value = !field ? Math.fround(0.3333) :
        field.type === 'FloatProperty' && field.size === 4 ? bytes.readFloatLE(field.start) : NaN
      result.cutoff = value >= 0 && value <= 1 ? value : null
    } else {
      result.doubleSided = bool(field)
    }
  }
  return result
}

function colorSample(bytes, table, material, input) {
  if (input?.type !== 'StructProperty' || input.inner !== 'ColorMaterialInput' || input.size !== 44 ||
      bytes.readInt32LE(input.start + 36) !== 0) return null
  const pending = [input]
  const visited = new Set()
  const samples = new Map()
  while (pending.length) {
    const field = pending.pop()
    const index = bytes.readInt32LE(field.start)
    const node = table.exported(index)
    if (node?.outer !== material.index) continue
    const channel = sampleChannel(bytes, field)
    const key = index + ':' + (channel ?? '')
    if (visited.has(key)) continue
    if (visited.size >= 64) return null
    visited.add(key)
    const sample = channel === 'rgb' && readTextureSample(bytes, table, material, node)
    if (sample?.sampleType === 'SAMPLERTYPE_Color') {
      samples.set(JSON.stringify(sample), sample)
      continue
    }
    const children = colorBranches.get(node.type)
    if (!children) continue
    const props = expressionFields(bytes, table, node)
    for (const label of children) {
      const child = props.get(label)
      if (child?.type === 'StructProperty' && child.inner === 'ExpressionInput' && child.size === 36) pending.push(child)
    }
  }
  return samples.size === 1 ? samples.values().next().value : null
}

export function readMaterialSurface(bytes, table, material, properties) {
  const { nameAt } = table
  if (material.type === 'MaterialInstanceConstant') {
    const field = properties.get('BasePropertyOverrides')
    if (!field) return { overrides: {} }
    if (field.type !== 'StructProperty' || field.inner !== 'MaterialInstanceBasePropertyOverrides') return null
    const tags = taggedProperties(bytes, field.start, field.end, nameAt)
    return tags.end === field.end ? { overrides: surfaceSettings(bytes, nameAt, tags.properties, true) } : null
  }
  const settings = surfaceSettings(bytes, nameAt, properties, false)
  const field = properties.get('OpacityMask')
  if (!usesMeshUv0(properties) || field?.type !== 'StructProperty' || field.inner !== 'ScalarMaterialInput' ||
      field.size !== 44 || bytes.readInt32LE(field.start + 36) !== 0) return { settings }
  const channel = sampleChannel(bytes, field)
  const sample = channel && readTextureSample(bytes, table, material, table.exported(bytes.readInt32LE(field.start)))
  if (!sample || !maskSamplers.has(sample.sampleType)) return { settings }
  return { settings, mask: { ...sample, channel }, color: colorSample(bytes, table, material, properties.get('BaseColor')) }
}
