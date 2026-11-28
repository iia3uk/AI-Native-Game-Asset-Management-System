const pathIdPattern = /^-?[1-9]\d{0,18}$/
const numericProperties = ['_Mode', '_Cutoff', '_Metallic', '_Glossiness']
const vector = (values, length) => Array.isArray(values) && values.length === length &&
  values.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 3.403e38)

function reference(value) {
  if (!Number.isInteger(value?.fileId) || value.fileId < 0 || value.fileId > 0x7fff_ffff ||
      typeof value.pathId !== 'string' || !pathIdPattern.test(value.pathId)) return null
  const id = BigInt(value.pathId)
  if (id < -(1n << 63n) || id >= 1n << 63n) return null
  return { fileId: value.fileId, pathId: value.pathId }
}

export function materialSource(value) {
  if (!value || ![null, 'standard'].includes(value.profile) ||
      !Array.isArray(value.textures) || value.textures.length > 64 ||
      !value.numbers || typeof value.numbers !== 'object' || Array.isArray(value.numbers) ||
      (value.color !== null && !vector(value.color, 4))) return null
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
  return { shader, profile: value.profile, textures, numbers, color: value.color }
}

export function meshMaterialSlots(value) {
  if (!value) return null
  if (['ambiguous', 'unresolved'].includes(value.status) && value.slots === null) return { status: value.status }
  if (value.status !== 'linked' || !Array.isArray(value.slots) || value.slots.length > 128) return null
  const slots = []
  for (const slot of value.slots) {
    const link = reference(slot)
    if (slot !== null && !link) return null
    slots.push(link)
  }
  return { status: 'linked', slots }
}
