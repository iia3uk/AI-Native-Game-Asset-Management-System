import { unityMaterialSlot } from '../../../materials/unity/shaders.mjs'

export const smoothnessFromAlbedo = '_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A'
export const unit = value => Math.max(0, Math.min(1, value))

export function standardSlotRoles(material, property) {
  const active = new Set(material.keywords)
  const roles = unityMaterialSlot(material.profile, property, {}, active)
  if (material.profile !== 'standard') return roles
  return roles.filter(({ role }) => role !== 'opacity' || material.numbers._Mode === 1)
}

export function standardSlotActive(property, active) {
  switch (property) {
    case '_MetallicGlossMap': return active.has('_METALLICGLOSSMAP')
    case '_BumpMap': return active.has('_NORMALMAP')
    case '_EmissionMap': return active.has('_EMISSION')
    case '_ParallaxMap': return active.has('_PARALLAXMAP')
    default: return true
  }
}
