import { ownedBodySetup, readBodySetup } from '../collision/body.mjs'

export function sourceMeshCollision(bytes, mesh, bodyIndex) {
  if (!bodyIndex) return null
  return readBodySetup(bytes, ownedBodySetup(mesh, bodyIndex), mesh.nameAt,
    { deriveHull: mesh.layout?.fileVersionUE4 === 514 })
}
