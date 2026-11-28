import { requireLayout } from '../../../engines/unreal/package-tables.mjs'
import { encodeSkeletalMesh } from './gltf.mjs'

const normalize = vector => {
  const length = Math.hypot(...vector)
  requireLayout(Number.isFinite(length) && length > 0.000001)
  return vector.map(value => value / length)
}

export function encodeCookedSkeletalMesh(bytes, product, rig, bin) {
  const { vertices, colors, uvs, indices, sections, influences, boneCount } = product
  requireLayout(rig?.objectClass === 'SkeletalMesh' && rig.bones.length === boneCount && bytes.length === product.size)
  const fields = {
    positions: new Float32Array(vertices * 3),
    normals: new Float32Array(vertices * 3),
    tangents: new Float32Array(vertices * 4),
    color: colors ? new Uint8Array(vertices * 4) : null,
    uvs: Array.from({ length: uvs }, () => new Float32Array(vertices * 2)),
    joints: Array.from({ length: influences / 4 }, () => new Uint16Array(vertices * 4)),
    weights: Array.from({ length: influences / 4 }, () => new Uint8Array(vertices * 4)),
  }
  const stride = 40 + 8 * uvs + (colors ? 4 : 0) + 3 * influences
  const indexBase = vertices * stride
  requireLayout(indexBase + indices * 4 === bytes.length)
  const materials = []
  const primitives = sections.map(section => {
    const { slot, name, material, baseVertex, vertices, firstIndex, endIndex } = section
    for (let vertex = baseVertex; vertex < baseVertex + vertices; vertex++) {
      readVertex(bytes, vertex * stride, vertex, influences, boneCount, fields)
    }
    const triangles = vertices <= 65536 ? new Uint16Array(endIndex - firstIndex) : new Uint32Array(endIndex - firstIndex)
    for (let index = firstIndex; index < endIndex; index += 3) {
      const a = bytes.readUInt32LE(indexBase + index * 4) - baseVertex
      const b = bytes.readUInt32LE(indexBase + (index + 1) * 4) - baseVertex
      const c = bytes.readUInt32LE(indexBase + (index + 2) * 4) - baseVertex
      requireLayout(Math.min(a, b, c) >= 0 && Math.max(a, b, c) < vertices)
      triangles.set([a, b, c], index - firstIndex)
    }
    materials[slot] ??= { name: name ?? 'Material_' + slot, path: material }
    return { indices: triangles, slot, baseVertex, vertices }
  })
  return encodeSkeletalMesh({ rig, materials, sections: primitives, fields }, bin, 'Asset Viewer Unreal cooked skeletal mesh')
}

function readVertex(bytes, at, index, influences, boneCount, fields) {
  const vector = offset => [0, 8, 4].map(axis => bytes.readFloatLE(at + offset + axis))
  const position = vector(0).map(value => Math.fround(value * 0.01))
  requireLayout(position.every(Number.isFinite))
  const normal = normalize(vector(12))
  const direction = vector(24)
  const dot = normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2]
  const tangent = normalize(direction.map((value, axis) => value - normal[axis] * dot))
  const sign = bytes.readFloatLE(at + 36)
  requireLayout(Math.abs(sign) === 1)
  fields.positions.set(position, index * 3)
  fields.normals.set(normal, index * 3)
  fields.tangents.set([...tangent, -sign], index * 4)
  at += 40
  for (const uv of fields.uvs) {
    const u = bytes.readFloatLE(at)
    const v = bytes.readFloatLE(at + 4)
    requireLayout(Number.isFinite(u) && Number.isFinite(v))
    uv.set([u, v], index * 2)
    at += 8
  }
  if (fields.color) {
    fields.color.set(bytes.subarray(at, at + 4), index * 4)
    at += 4
  }
  let sum = 0
  const seen = new Set()
  for (let slot = 0; slot < influences; slot++, at += 3) {
    const bone = bytes.readUInt16LE(at)
    const weight = bytes[at + 2]
    if (!weight) {
      requireLayout(bone === 0)
      continue
    }
    requireLayout(bone < boneCount && !seen.has(bone))
    seen.add(bone)
    sum += weight
    const group = slot >> 2
    const component = index * 4 + (slot & 3)
    fields.joints[group][component] = bone
    fields.weights[group][component] = weight
  }
  requireLayout(sum === 255)
}
