import { bundleMemberPattern } from './member.mjs'

const pathIdPattern = /^-?[1-9]\d{0,18}$/
const numericProperties = ['_Mode', '_Cutoff', '_Metallic', '_Glossiness', '_GlossMapScale',
  '_OcclusionStrength', '_BumpScale', '_SmoothnessTextureChannel']
const materialKeywords = new Set(['_METALLICGLOSSMAP', '_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A', '_NORMALMAP', '_EMISSION',
  '_PARALLAXMAP', '_DETAIL_MULX2', '_DETAIL_MUL', '_DETAIL_ADD', '_DETAIL_LERP', '_SPECULARHIGHLIGHTS_OFF',
  '_GLOSSYREFLECTIONS_OFF', '_ALPHATEST_ON', '_ALPHABLEND_ON', '_ALPHAPREMULTIPLY_ON'])
const vector = (values, length) => Array.isArray(values) && values.length === length &&
  values.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 3.403e38)

function reference(value) {
  if (!Number.isInteger(value?.fileId) || value.fileId < 0 || value.fileId > 0x7fff_ffff ||
      typeof value.pathId !== 'string' || !pathIdPattern.test(value.pathId)) return null
  const id = BigInt(value.pathId)
  if (id < -(1n << 63n) || id >= 1n << 63n) return null
  const { fileId, pathId, targetMember } = value
  if (targetMember !== undefined && (!fileId || typeof targetMember !== 'string' || !bundleMemberPattern.test(targetMember))) return null
  return { fileId, pathId, ...(targetMember && { targetMember }) }
}
export function materialSource(value) {
  if (!value || ![null, 'standard'].includes(value.profile) ||
      !Array.isArray(value.textures) || value.textures.length > 64 ||
      !value.numbers || typeof value.numbers !== 'object' || Array.isArray(value.numbers) ||
      (value.color !== null && !vector(value.color, 4))) return null
  const { keywords, emissionColor, mainTransform } = value
  if (keywords !== undefined && (!Array.isArray(keywords) || keywords.length > materialKeywords.size ||
      !keywords.every(keyword => materialKeywords.has(keyword)) || new Set(keywords).size !== keywords.length)) return null
  if (emissionColor !== undefined && !vector(emissionColor, 4)) return null
  if (mainTransform !== undefined && (!vector(mainTransform?.scale, 2) || !vector(mainTransform?.offset, 2))) return null
  const shader = reference(value.shader)
  if ((value.shader !== null || value.profile) && !shader) return null
  const numbers = {}
  for (const [name, number] of Object.entries(value.numbers)) {
    if (!numericProperties.includes(name) || !vector([number], 1)) return null
    numbers[name] = number
  }
  const textures = []
  const properties = new Set()
  for (const slot of value.textures) {
    const texture = reference(slot?.texture)
    if (!texture || typeof slot.property !== 'string' || !slot.property.length || slot.property.length > 80 ||
        /\p{Cc}/u.test(slot.property) ||
        properties.has(slot.property) || !vector(slot.scale, 2) || !vector(slot.offset, 2)) return null
    properties.add(slot.property)
    const { property, scale, offset } = slot
    textures.push({ property, texture, scale, offset })
  }
  return { shader, profile: value.profile, textures, numbers, color: value.color,
    ...(keywords && { keywords }), ...(emissionColor && { emissionColor }),
    ...(mainTransform && { mainTransform: { scale: mainTransform.scale, offset: mainTransform.offset } }) }
}

export function meshMaterialSlots(value) {
  if (!value) return null
  const { rendererMember } = value
  if (rendererMember === undefined && ['ambiguous', 'unresolved'].includes(value.status) && value.slots === null) return { status: value.status }
  if (value.status !== 'linked' || !Array.isArray(value.slots) || value.slots.length > 128) return null
  if (rendererMember !== undefined && (typeof rendererMember !== 'string' || !bundleMemberPattern.test(rendererMember))) return null
  const slots = []
  for (const slot of value.slots) {
    const link = reference(slot)
    if (slot !== null && !link) return null
    slots.push(link)
  }
  return { status: 'linked', slots, ...(rendererMember && { rendererMember }) }
}
