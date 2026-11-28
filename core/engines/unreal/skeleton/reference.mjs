import { requireLayout, skipUnrealString } from '../package-tables.mjs'

export const maxReferenceBones = 2048

const validName = name => name && name !== 'None' && !/[\u0000-\u001f\u007f]/u.test(name)

export function readReferenceSkeleton(bytes, start, nameAt, editor) {
  const end = bytes.length
  requireLayout(start + 4 <= end)
  const count = bytes.readInt32LE(start)
  requireLayout(count > 0 && count <= maxReferenceBones && count * 64 + 12 <= end - start)
  let at = start + 4
  const indices = new Map()
  const bones = []
  for (let index = 0; index < count; index++) {
    requireLayout(at + 12 <= end)
    const name = nameAt(at)
    const parent = bytes.readInt32LE(at + 8)
    const key = name.toLowerCase()
    requireLayout(validName(name) && !indices.has(key) && (index === 0 ? parent === -1 : parent >= 0 && parent < index))
    indices.set(key, index)
    at += 12
    bones.push({ name, parent })
    if (editor) at = skipUnrealString(bytes, at, end)
  }

  requireLayout(at + 8 + count * 52 <= end && bytes.readInt32LE(at) === count)
  at += 4
  for (const bone of bones) {
    const values = Array.from({ length: 10 }, (_, index) => bytes.readFloatLE(at + index * 4))
    requireLayout(values.every(Number.isFinite))
    bone.rotation = values.slice(0, 4)
    requireLayout(Math.abs(Math.hypot(...bone.rotation) - 1) <= 0.01)
    bone.translation = values.slice(4, 7)
    bone.scale = values.slice(7)
    at += 40
  }
  requireLayout(bytes.readInt32LE(at) === count)
  at += 4
  for (let index = 0; index < count; index++) {
    const key = nameAt(at).toLowerCase()
    requireLayout(indices.has(key) && indices.get(key) === bytes.readInt32LE(at + 8))
    indices.delete(key)
    at += 12
  }
  return { bones, end: at }
}
