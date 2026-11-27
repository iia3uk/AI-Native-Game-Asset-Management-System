import { PropertyBinding } from 'three'

function ancestorPath(node, model) {
  const path = []
  while (node && node !== model) {
    path.push(node)
    node = node.parent
  }
  return node === model ? [model, ...path.reverse()] : []
}

export function animatedTranslationRoot(model, clip) {
  const skinJoints = new Set()
  const bones = []
  const geometry = []
  model.traverse(node => {
    if (node.isSkinnedMesh) for (const joint of node.skeleton?.bones ?? []) skinJoints.add(joint)
    if (node.isBone) bones.push(node)
    if (node.isMesh || node.isLine || node.isPoints) geometry.push(node)
  })
  const objects = skinJoints.size ? [...skinJoints] : bones.length ? bones : geometry
  if (!objects.length) return null
  let roots = ancestorPath(objects[0], model)
  for (const node of objects.slice(1)) {
    const path = ancestorPath(node, model)
    const mismatch = roots.findIndex((ancestor, index) => ancestor !== path[index])
    if (mismatch >= 0) roots = roots.slice(0, mismatch)
    if (!roots.length) return null
  }
  const animated = new Set()
  for (const track of clip.tracks) {
    if (!/\.position(?:\[[xyz012]\])?$/.test(track.name)) continue
    const binding = PropertyBinding.parseTrackName(track.name)
    const node = PropertyBinding.findNode(model, binding.nodeName)
    if (binding.objectName === 'bones') animated.add(node?.skeleton?.getBoneByName(binding.objectIndex))
    else if (!binding.objectName) animated.add(node)
  }
  return roots.find(node => animated.has(node)) ?? null
}
