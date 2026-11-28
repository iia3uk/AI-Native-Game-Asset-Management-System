import { editorPackage } from '../editor-package/tables.mjs'

const meshClass = new Set(['StaticMesh'])

export function staticMeshPackage(bytes) {
  const table = editorPackage(bytes)
  const mesh = table?.topLevel(meshClass)
  return mesh && { ...table, ...mesh }
}
