import { requireLayout } from './tables.mjs'

const extras = new Map([
  ['StructProperty', 24], ['ArrayProperty', 8], ['SetProperty', 8], ['ByteProperty', 8],
  ['EnumProperty', 8], ['MapProperty', 16], ['BoolProperty', 1],
])

function tag(bytes, at, end, nameAt) {
  requireLayout(at + 8 <= end)
  const name = nameAt(at)
  if (name === 'None') return { name, end: at + 8 }
  requireLayout(at + 25 <= end)
  const type = nameAt(at + 8)
  const size = bytes.readInt32LE(at + 16)
  const arrayIndex = bytes.readInt32LE(at + 20)
  const metadata = at + 24
  const extra = extras.get(type) ?? 0
  const guid = metadata + extra
  requireLayout(size >= 0 && arrayIndex >= 0 && guid < end && bytes[guid] <= 1)
  const start = guid + (bytes[guid] ? 17 : 1)
  requireLayout(start + size <= end)
  const inner = extra >= 8 ? nameAt(metadata) : null
  return { name, type, inner, size, start, end: start + size, arrayIndex,
    ...(type === 'BoolProperty' && { value: bytes[metadata] }) }
}

export function taggedProperties(bytes, start, end, nameAt) {
  const properties = new Map()
  for (let count = 0; count <= 2048; count++) {
    const field = tag(bytes, start, end, nameAt)
    if (field.name === 'None') return { end: field.end, properties }
    if (field.arrayIndex === 0) {
      requireLayout(!properties.has(field.name))
      properties.set(field.name, field)
    }
    start = field.end
  }
  throw new RangeError('Too many Unreal property tags')
}

function structArrayDescriptor(bytes, field, nameAt, type, limit) {
  requireLayout(field?.type === 'ArrayProperty' && field.inner === 'StructProperty' && field.size >= 4)
  const count = bytes.readInt32LE(field.start)
  requireLayout(count >= 0 && count <= limit)
  if (count === 0 && field.size === 4) return { count, start: field.end }
  const descriptor = tag(bytes, field.start + 4, field.end, nameAt)
  requireLayout(descriptor.type === 'StructProperty' && descriptor.name === field.name &&
    descriptor.inner === type && descriptor.end === field.end)
  return { count, start: descriptor.start }
}

export function structArray(bytes, field, nameAt, type, limit = 256) {
  const { count, start } = structArrayDescriptor(bytes, field, nameAt, type, limit)
  const rows = []
  let at = start
  for (let index = 0; index < count; index++) {
    const row = taggedProperties(bytes, at, field.end, nameAt)
    rows.push(row.properties)
    at = row.end
  }
  requireLayout(at === field.end)
  return rows
}

export function nativeStructArray(bytes, field, nameAt, type, stride, limit) {
  const { count, start } = structArrayDescriptor(bytes, field, nameAt, type, limit)
  requireLayout(start + count * stride === field.end)
  return { count, start }
}
