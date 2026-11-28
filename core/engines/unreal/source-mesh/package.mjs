import { taggedProperties } from '../editor-package/properties.mjs'
import { editorPackage, requireLayout } from '../editor-package/tables.mjs'

const meshClass = new Set(['StaticMesh'])

export function staticMeshPackage(bytes) {
  const table = editorPackage(bytes)
  const mesh = table?.topLevel(meshClass)
  return mesh && { ...table, ...mesh }
}

export function staticMeshHeader(bytes, mesh) {
  const { start, end, nameAt } = mesh
  const tags = taggedProperties(bytes, start, end, nameAt)
  requireLayout(tags.end + 4 <= end)
  const hasGuid = bytes.readInt32LE(tags.end)
  requireLayout(hasGuid === 0 || hasGuid === 1)
  const flags = tags.end + (hasGuid ? 20 : 4)
  requireLayout(flags + 14 <= end && (bytes[flags] & 1) === 0 && bytes.readInt32LE(flags + 2) === 0)
  return { flags, properties: tags.properties, bodyIndex: bytes.readInt32LE(flags + 6) }
}
