const matchKey = names => JSON.stringify([...names].sort())

export function viewerSkeleton(document) {
  if (!/^UE Viewer \(umodel\) build \d+$/.test(document?.asset?.generator) ||
      document.skins?.length !== 1 || !Array.isArray(document.nodes)) return null
  const { joints, skeleton } = document.skins[0]
  if (!Array.isArray(joints) || !joints.length || joints.length > 512 || !joints.includes(skeleton) ||
      new Set(joints).size !== joints.length) return null
  const jointSet = new Set(joints)
  const reached = new Set()
  const bones = new Map()
  const pending = [skeleton]
  while (pending.length) {
    const index = pending.pop()
    const node = document.nodes[index]
    if (!Number.isInteger(index) || !jointSet.has(index) || reached.has(index) ||
        typeof node?.name !== 'string' || !node.name || bones.has(node.name) ||
        node.matrix || node.scale || !validVector(node.translation, 3) || !validVector(node.rotation, 4) ||
        (node.children !== undefined && !Array.isArray(node.children))) return null
    reached.add(index)
    bones.set(node.name, { node: index, translation: node.translation, rotation: node.rotation, root: index === skeleton })
    if (node.children?.length > joints.length) return null
    for (const child of node.children ?? []) pending.push(child)
  }
  return reached.size === joints.length ? { bones, key: matchKey(bones.keys()) } : null
}

function validVector(value, size) {
  return Array.isArray(value) && value.length === size && value.every(Number.isFinite)
}

export const actorXBoneKey = psa => matchKey(psa.bones.keys())

export function actorXBinding(psa, skeleton) {
  if (psa.bones.size !== skeleton.bones.size) return null
  let referenceLength = 0
  let dot = 0
  const pairs = []
  for (const [name, bone] of psa.bones) {
    const joint = skeleton.bones.get(name)
    if (!joint) return null
    const [qx, qy, qz, w] = bone.rotation
    const rotation = [-qx, -qz, -qy, w]
    const alignment = rotation.reduce((sum, value, index) => sum + value * joint.rotation[index], 0)
    if (Math.abs(alignment) < .99999 || Math.abs(Math.hypot(...joint.rotation) - 1) > .00001) return null
    const [x, y, z] = bone.position
    const reference = [x, z, y]
    for (const [index, value] of reference.entries()) {
      const target = joint.translation[index]
      pairs.push([value, target])
      referenceLength += value * value
      dot += target * value
    }
  }
  // Some meshes apply a uniform import scale to the shared reference skeleton.
  const scale = referenceLength > 1e-8 ? dot / referenceLength : .01
  if (!(scale > .00001 && scale < 1) ||
      pairs.some(([value, target]) => Math.abs(value * scale - target) > .00002 + Math.abs(target) * .00002)) return null
  return { scale, bones: skeleton.bones }
}
