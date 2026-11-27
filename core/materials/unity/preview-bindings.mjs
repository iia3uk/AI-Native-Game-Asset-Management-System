import { describeUnityMaterial } from './describe.mjs'

const unit = (value, fallback) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback

function surfaceSettings(profile, numbers, colors, keywords) {
  const standard = profile === 'standard'
  const hd = profile === 'hdrp-lit'
  const specular = profile === 'urp-lit' && (numbers._WorkflowMode === 0 || keywords.has('_SPECULAR_SETUP'))
  if ((standard ? (numbers._Mode ?? 0) > 1 : numbers._Surface === 1 || numbers._SurfaceType === 1) || specular ||
      (hd && ((numbers._UVBase ?? 0) !== 0 || (numbers._MaterialID ?? 1) !== 1))) return null
  const cutout = keywords.has('_ALPHATEST_ON') || numbers._Mode === 1 ||
    numbers._AlphaClip === 1 || numbers._AlphaCutoffEnable === 1
  const color = colors[standard ? '_Color' : '_BaseColor'] ?? [1, 1, 1, 1]
  return {
    color: color.slice(0, 3).map(value => unit(value, 1)), opacity: cutout ? unit(color[3], 1) : 1,
    cutoff: cutout ? unit(hd ? numbers._AlphaCutoff : numbers._Cutoff, .5) : 0,
    metalness: unit(numbers._Metallic, 0), roughness: 1 - unit(standard ? numbers._Glossiness : numbers._Smoothness, .5),
    aoStrength: hd ? 1 : unit(numbers._OcclusionStrength, 1),
    normalScale: Math.max(-8, Math.min(8, (hd ? numbers._NormalScale : numbers._BumpScale) ?? 1)),
    emissive: (hd ? colors._EmissiveColor : keywords.has('_EMISSION') && colors._EmissionColor) || [0, 0, 0, 1],
  }
}

function channelRange(profile, role, numbers) {
  if (profile === 'hdrp-lit') {
    const prefix = { metallic: '_Metallic', roughness: '_Smoothness', ambientOcclusion: '_AO' }[role]
    if (prefix) return [unit(numbers[prefix + 'RemapMin'], 0), unit(numbers[prefix + 'RemapMax'], 1)]
  }
  if (role === 'roughness') return [0, unit(profile === 'standard' ? numbers._GlossMapScale : numbers._Smoothness, profile === 'standard' ? 1 : .5)]
  return [0, 1]
}

export function unityPreviewBinding(material, resolveTexture) {
  const description = describeUnityMaterial(material, {}, resolveTexture)
  const { profile } = description.shader
  if (!profile) return null
  const { numbers, colors } = description.properties
  const keywords = new Set(description.properties.keywords)
  const surface = surfaceSettings(profile, numbers, colors, keywords)
  if (!surface) return null

  const baseSlot = description.textures.find(binding => binding.roles.some(role => role.role === 'baseColor'))
  const useBaseAlpha = !baseSlot?.roles.some(role => role.role === 'roughness')
  // The basic alpha test samples the same source alpha as the color map.
  if (surface.cutoff && !useBaseAlpha) return null
  const hd = profile === 'hdrp-lit'
  const maps = Object.create(null)
  for (const binding of description.textures) {
    const target = binding.target
    if (!target || target.status !== 'file-resolved') continue
    const { importer } = target
    for (const { role, channels, colorSpace, operation } of binding.roles) {
      if (role === 'normal' && (!importer?.normalMap || importer.convertToNormal || (hd && numbers._NormalMapSpace === 1))) continue
      if (role === 'emissive' && !(hd ? (numbers._UVEmissive ?? 0) === 0 : keywords.has('_EMISSION'))) continue
      if (role === 'metallic' && !hd && !keywords.has(profile === 'standard' ? '_METALLICGLOSSMAP' : '_METALLICSPECGLOSSMAP')) continue
      if (role === 'roughness' && binding !== baseSlot && !hd &&
          !keywords.has(profile === 'standard' ? '_METALLICGLOSSMAP' : '_METALLICSPECGLOSSMAP')) continue
      if (!['baseColor', 'normal', 'emissive', 'roughness', 'metallic', 'ambientOcclusion'].includes(role)) continue
      const uv = hd && role === 'emissive' ? binding : baseSlot
      maps[role] = { url: target.url, channels, operation,
        colorSpace: role === 'normal' ? 'linear' : importer?.colorSpace ?? colorSpace,
        ...(role === 'normal' && { flipGreen: importer.flipGreen === true }),
        scale: uv?.scale, offset: uv?.offset, range: channelRange(profile, role, numbers) }
    }
  }
  return { profile, surface, maps }
}
