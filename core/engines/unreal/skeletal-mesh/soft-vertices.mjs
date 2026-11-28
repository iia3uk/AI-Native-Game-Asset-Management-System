import { requireLayout } from '../package-tables.mjs'

export const softSkinVertexSize = 76

const normalize = values => {
  const length = Math.hypot(...values)
  requireLayout(length > 0.000001 && Number.isFinite(length))
  return values.map(value => value / length)
}

const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0)
const cross = ([x, y, z], [a, b, c]) => [y * c - z * b, z * a - x * c, x * b - y * a]
const packedDirection = (bytes, at) => [bytes[at] - 127.5, bytes[at + 2] - 127.5, bytes[at + 1] - 127.5]

export function readSoftSkinVertex(bytes, at, index, section, { positions, normals, tangents, color, uvs, joints, weights }) {
  const position = [0, 8, 4].map(offset => Math.fround(bytes.readFloatLE(at + offset) * 0.01))
  requireLayout(position.every(Number.isFinite))
  const direction = packedDirection(bytes, at + 12)
  const bitangent = packedDirection(bytes, at + 16)
  const normal = normalize(packedDirection(bytes, at + 20))
  const alongNormal = dot(direction, normal)
  const tangent = normalize(direction.map((value, axis) => value - alongNormal * normal[axis]))
  const handedness = dot(cross(normal, tangent), bitangent)
  requireLayout(Math.abs(handedness) > 0.01)
  positions.set(position, index * 3)
  normals.set(normal, index * 3)
  tangents.set([...tangent, handedness < 0 ? -1 : 1], index * 4)
  if (color) color.set([bytes[at + 58], bytes[at + 57], bytes[at + 56], bytes[at + 59]], index * 4)
  for (const [channel, uv] of uvs.entries()) {
    const u = bytes.readFloatLE(at + 24 + channel * 8)
    const v = bytes.readFloatLE(at + 28 + channel * 8)
    requireLayout(Number.isFinite(u) && Number.isFinite(v))
    uv.set([u, v], index * 2)
  }
  let sum = 0
  let used = 0
  const seen = new Set()
  for (let slot = 0; slot < 8; slot++) {
    const weight = bytes[at + 68 + slot]
    if (!weight) continue
    const bone = section.bones[bytes[at + 60 + slot]]
    requireLayout(used < section.influences && bone !== undefined && !seen.has(bone))
    seen.add(bone)
    const group = Math.floor(used / 4)
    const component = index * 4 + used % 4
    joints[group][component] = bone
    weights[group][component] = weight
    used++
    sum += weight
  }
  requireLayout(sum === 255)
}
