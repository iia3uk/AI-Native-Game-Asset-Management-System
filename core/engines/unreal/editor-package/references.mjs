import { posix } from 'node:path'

const packagePath = /^\/Game\/(?:[^.\s/\\:\u0000-\u001f]+\/)*[^.\s/\\:\u0000-\u001f]+$/u

export function importedGameObject(imported, index, types) {
  const object = imported(index)
  if (!object || !types.has(object.type)) return null
  const owner = imported(object.outer)
  return owner?.type === 'Package' && owner.outer === 0 && packagePath.test(owner.name) &&
    posix.basename(owner.name) === object.name ? owner.name : null
}

export function softGameObject(reference) {
  const dot = reference.lastIndexOf('.')
  const path = reference.slice(0, dot)
  return dot > 0 && packagePath.test(path) && posix.basename(path) === reference.slice(dot + 1) ? path : null
}
