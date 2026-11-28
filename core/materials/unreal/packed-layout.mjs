const layouts = new Map([
  ['orm', 'ORM'], ['occlusionroughnessmetallic', 'ORM'], ['ambientocclusionroughnessmetallic', 'ORM'],
  ['rma', 'RMA'], ['roughnessmetallicambientocclusion', 'RMA'], ['roughnessmetallicao', 'RMA'],
  ['mra', 'MRA'], ['metallicroughnessambientocclusion', 'MRA'], ['metallicroughnessao', 'MRA'],
])

export const packedLayout = name => layouts.get(name) ?? null

export const ormSources = Object.freeze({
  ORM: [0, 1, 2],
  RMA: [2, 0, 1],
  MRA: [2, 1, 0],
})

export const ormChannels = Object.freeze({ ambientOcclusion: 'red', roughness: 'green', metallic: 'blue' })

export function choosePackedMap(bindings) {
  const packed = bindings.filter(binding => binding.layout)
  const [binding] = packed
  if (!binding) return null
  if (packed.some(item => item.sourcePath !== binding.sourcePath || item.layout !== binding.layout)) {
    return { issue: 'unreal-packed-material-ambiguous' }
  }
  if (!binding.corroborated) return { issue: 'unreal-packed-material-unconfirmed' }
  if (!binding.path || !binding.textureId) return { issue: 'unreal-packed-material-missing' }
  return { binding }
}
