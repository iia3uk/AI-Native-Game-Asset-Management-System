import { posix } from 'node:path'

export const editorAnimationMethod = 'unreal-editor-animation'
export const editorAnimationBindingMethod = 'unreal-editor-animation-binding'
export const animationSkeletonDependency = 'unreal-animation-skeleton'
export const modelAnimationDependency = 'unreal-model-animation'

export function editorClipPath(asset) {
  const name = posix.basename(asset.sourcePath).slice(0, -7).replace(/[#%]/g, '_')
  return 'Animations/' + asset.id + '/' + name + '.glb'
}

export function declaredSkeleton(resolve, skeletons, path, asset) {
  const target = path && resolve(path, asset)
  const rig = target && skeletons.reference(target)
  const exact = rig?.objectClass === 'Skeleton' && rig.object.toLowerCase() === posix.basename(path).toLowerCase()
  return { target, rig: exact ? rig : null }
}

export function modelJointNodes(document, mesh, rig) {
  const joints = document.skins?.[0]?.joints
  if (!joints || joints.length !== mesh.bones.length) return null
  const indexByName = new Map(mesh.bones.map((bone, index) => [bone.name, index]))
  const nodes = []
  for (const bone of rig.bones) {
    const index = indexByName.get(bone.name)
    const local = mesh.bones[index]
    if (!local || document.nodes[joints[index]]?.name !== bone.name || (local.parent < 0) !== (bone.parent < 0) ||
        (bone.parent >= 0 && mesh.bones[local.parent].name !== rig.bones[bone.parent].name)) return null
    nodes.push(joints[index])
  }
  return nodes
}
