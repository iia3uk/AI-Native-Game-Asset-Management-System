const collisionPrefix = /^(?:UCX|UBX|USP|UCP|MCDCX)_/i
const collisionSuffix = /[_ -]ConvexHulls?$/i
const collisionFolder = /(?:^|\/)(?:Colliders|Collisions?)(?:\/|$)/i
const stem = filename => filename.replace(/\.[^.]+$/, '')

export const isCollisionName = name => collisionPrefix.test(name) || collisionSuffix.test(name)
export const isCollisionFile = file => file?.kind === 'model' &&
  (isCollisionName(stem(file.name)) || collisionFolder.test(file.displayPath ?? file.path ?? ''))

export function visualModelFor(collider, files) {
  const name = stem(collider.name).replace(collisionPrefix, '').replace(collisionSuffix, '').toLowerCase()
  const targets = files.filter(file => file.kind === 'model' && !isCollisionFile(file) && stem(file.name).toLowerCase() === name)
  const sameFormat = targets.filter(file => file.ext === collider.ext)
  if (sameFormat.length === 1) return sameFormat[0]
  return targets.length === 1 ? targets[0] : undefined
}
