const builtIn = '0000000000000000f000000000000000'
const urpLit = '933532a4fcc9baf4fa0491de14d08ed7'
const hdrpLit = '6e4ae4064600d784cac1e41a9e6f2e59'

const base = { role: 'baseColor', channels: 'rgb', colorSpace: 'srgb' }
const normal = { role: 'normal', channels: 'rgb', colorSpace: 'linear' }
const ao = { role: 'ambientOcclusion', channels: 'g', colorSpace: 'linear' }
const metallic = { role: 'metallic', channels: 'r', colorSpace: 'linear' }
const smoothness = { role: 'roughness', channels: 'a', colorSpace: 'linear', operation: 'one-minus-smoothness' }
const emission = { role: 'emissive', channels: 'rgb', colorSpace: 'srgb' }
const specular = { role: 'specular', channels: 'rgb', colorSpace: 'srgb' }
const opacity = { role: 'opacity', channels: 'a', colorSpace: 'linear' }
const height = { role: 'height', channels: 'g', colorSpace: 'linear' }

export function unityShaderProfile(shader) {
  if (shader?.guid === builtIn && shader.fileID === '46') return 'standard'
  if (shader?.fileID === '4800000' && shader.guid === urpLit) return 'urp-lit'
  if (shader?.fileID === '4800000' && shader.guid === hdrpLit) return 'hdrp-lit'
  return null
}

export const baseColorSlots = ['_BaseMap', '_BaseColorMap', '_MainTex', '_AlbedoMap']

export function unityMaterialSlot(profile, property, numbers, keywords) {
  if (!profile) return []
  if (profile === 'hdrp-lit') {
    switch (property) {
      case '_BaseColorMap': return [base, opacity]
      case '_NormalMap': return [normal]
      case '_EmissiveColorMap': return [emission]
      case '_MaskMap': return [metallic, ao, { role: 'detailMask', channels: 'b', colorSpace: 'linear' }, smoothness]
      case '_SpecularColorMap': return [specular]
      // HDRP height encoding depends on displacement mode and remapping settings.
      case '_HeightMap': return [{ role: 'height', channels: null, colorSpace: 'linear' }]
      default: return []
    }
  }
  const specularWorkflow = profile === 'urp-lit' && (numbers._WorkflowMode === 0 || keywords.has('_SPECULAR_SETUP'))
  const albedoSmoothness = keywords.has('_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A') ||
    (profile === 'urp-lit' ? numbers._SmoothnessTextureChannel : numbers._SmoothnessTextureChannel ?? numbers._SmoothnessTextureChannelMode) === 1
  if (property === (profile === 'standard' ? '_MainTex' : '_BaseMap')) {
    return [base, ...(albedoSmoothness ? [smoothness] : [opacity])]
  }
  switch (property) {
    case '_BumpMap': return [normal]
    case '_EmissionMap': return [emission]
    case '_OcclusionMap': return [ao]
    case '_ParallaxMap': return [height]
    case '_MetallicGlossMap': return specularWorkflow ? [] : [metallic, ...(!albedoSmoothness ? [smoothness] : [])]
    case '_SpecGlossMap': return specularWorkflow ? [specular, ...(!albedoSmoothness ? [smoothness] : [])] : []
    default: return []
  }
}
