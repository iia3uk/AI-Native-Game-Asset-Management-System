import { requireLayout } from '../editor-package/tables.mjs'

const scalarReaders = new Map([
  ['FloatProperty', (bytes, start) => bytes.readFloatLE(start)],
  ['IntProperty', (bytes, start) => bytes.readInt32LE(start)],
  ['ObjectProperty', (bytes, start) => bytes.readInt32LE(start)],
])

export function cueObjectIndex(bytes, field) {
  requireLayout(field?.type === 'ObjectProperty' && field.size === 4)
  return bytes.readInt32LE(field.start)
}

export function cueArray(bytes, field, inner, limit = 64) {
  requireLayout(field?.type === 'ArrayProperty' && field.inner === inner && field.size >= 4)
  const count = bytes.readInt32LE(field.start)
  requireLayout(count >= 0 && count <= limit && field.size === 4 + count * 4)
  const read = scalarReaders.get(inner)
  return Array.from({ length: count }, (_, index) => {
    const value = read(bytes, field.start + 4 + index * 4)
    requireLayout(Number.isFinite(value))
    return value
  })
}

export function cueSettings(bytes, properties, fields) {
  const settings = {}
  for (const [name, type] of Object.entries(fields)) {
    const field = properties.get(name)
    if (!field) continue
    if (type === 'ArrayProperty') {
      settings[name] = cueArray(bytes, field, 'FloatProperty')
    } else if (type === 'BoolProperty') {
      requireLayout(field.type === type && field.size === 0 && (field.value === 0 || field.value === 1))
      settings[name] = field.value === 1
    } else {
      requireLayout(field.type === type && field.size === 4)
      const value = scalarReaders.get(type)(bytes, field.start)
      requireLayout(Number.isFinite(value))
      settings[name] = value
    }
  }
  return settings
}
