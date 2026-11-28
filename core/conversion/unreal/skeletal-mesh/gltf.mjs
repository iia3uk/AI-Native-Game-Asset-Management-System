import { Matrix4, Quaternion, Vector3 } from 'three'
import { requireLayout } from '../../../engines/unreal/package-tables.mjs'
import { meshBuffer } from '../gltf-buffer.mjs'

export function unrealTranslation([x, y, z]) {
  return [x * 0.01, z * 0.01, y * 0.01]
}

export function unrealRotation([x, y, z, w]) {
  return [-x, -z, -y, w]
}

export function unrealScale([x, y, z]) {
  return [x, z, y]
}

export function unrealBoneNode(bone) {
  return { name: bone.name, translation: unrealTranslation(bone.translation),
    rotation: new Quaternion(...unrealRotation(bone.rotation)).normalize().toArray(), scale: unrealScale(bone.scale) }
}

function referenceSkin(bones) {
  const nodes = []
  const bindWorld = []
  const inverse = new Float32Array(bones.length * 16)
  for (const [index, bone] of bones.entries()) {
    const node = unrealBoneNode(bone)
    const local = new Matrix4().compose(new Vector3(...node.translation), new Quaternion(...node.rotation), new Vector3(...node.scale))
    const world = bone.parent < 0 ? local : new Matrix4().multiplyMatrices(bindWorld[bone.parent], local)
    const determinant = world.determinant()
    requireLayout(Number.isFinite(determinant) && determinant !== 0)
    bindWorld.push(world)
    inverse.set(world.clone().invert().elements, index * 16)
    nodes.push(node)
    if (bone.parent >= 0) (nodes[bone.parent].children ??= []).push(index + 1)
  }
  requireLayout(inverse.every(Number.isFinite))
  return { nodes, inverse }
}

function positionBounds(positions) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < positions.length; index++) {
    const axis = index % 3
    min[axis] = Math.min(min[axis], positions[index])
    max[axis] = Math.max(max[axis], positions[index])
  }
  return { min, max }
}

export function encodeEditorSkeletalMesh({ rig, materials, sections, fields }, bin) {
  const { append, finish } = meshBuffer()
  const { positions, normals, tangents, color, uvs, joints, weights } = fields
  const used = [...new Set(sections.map(section => section.slot))]
  const primitives = sections.map(({ indices, slot, baseVertex, vertices }, section) => {
    const slice = (values, components) => values.subarray(baseVertex * components, (baseVertex + vertices) * components)
    const points = slice(positions, 3)
    const attributes = {
      POSITION: append(points, 3, 5126, 34962, positionBounds(points)),
      NORMAL: append(slice(normals, 3), 3, 5126, 34962),
      TANGENT: append(slice(tangents, 4), 4, 5126, 34962),
    }
    if (color) attributes.COLOR_0 = append(slice(color, 4), 4, 5121, 34962, { normalized: true })
    for (const [index, uv] of uvs.entries()) attributes['TEXCOORD_' + index] = append(slice(uv, 2), 2, 5126, 34962)
    for (const [index, group] of joints.entries()) {
      attributes['JOINTS_' + index] = append(slice(group, 4), 4, 5123, 34962)
      attributes['WEIGHTS_' + index] = append(slice(weights[index], 4), 4, 5121, 34962, { normalized: true })
    }
    return { attributes, indices: append(indices, 1, indices instanceof Uint16Array ? 5123 : 5125, 34963),
      material: used.indexOf(slot), extras: { unrealSection: section } }
  })
  const { nodes, inverse } = referenceSkin(rig.bones)
  const inverseBindMatrices = append(inverse, 16, 5126)
  const { layout, buffer } = finish(bin)
  const document = {
    asset: { version: '2.0', generator: 'Asset Viewer Unreal editor skeletal mesh' },
    scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: rig.object, mesh: 0, skin: 0 }, ...nodes],
    meshes: [{ name: rig.object, primitives }],
    skins: [{ name: rig.object + '_Skin', skeleton: 1, joints: nodes.map((_, index) => index + 1), inverseBindMatrices }],
    materials: used.map(slot => ({
      name: materials[slot].name,
      pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.5 },
      extras: { unrealMaterialSlot: slot, unrealImportedMaterialSlot: materials[slot].original,
        ...(materials[slot].path && { unrealMaterial: materials[slot].path }) },
    })),
    ...layout,
  }
  return { document, buffer, materialPaths: [...new Set(used.map(slot => materials[slot].path).filter(Boolean))] }
}
