import { readTextureSample, sampleChannel, usesMeshUv0 } from './sample-input.mjs'

export function directNormalInput(bytes, table, material, properties) {
  const input = properties.get('Normal')
  const tangentSpace = properties.get('bTangentSpaceNormal')
  if (input?.type !== 'StructProperty' || input.inner !== 'VectorMaterialInput' || input.size !== 52 ||
      (tangentSpace && (tangentSpace.type !== 'BoolProperty' || tangentSpace.size !== 0 || tangentSpace.value !== 1)) ||
      !usesMeshUv0(properties) || sampleChannel(bytes, input) !== 'rgb' || bytes.readInt32LE(input.start + 36) !== 0) return null
  const sample = readTextureSample(bytes, table, material, table.exported(bytes.readInt32LE(input.start)))
  if (sample?.sampleType !== 'SAMPLERTYPE_Normal') return null
  const { sampleType, ...source } = sample
  return source
}
