import { unrealBoneNode, unrealRotation, unrealScale, unrealTranslation } from '../skeletal-mesh/gltf.mjs'

const channels = [
  ['translation', 3, unrealTranslation],
  ['rotation', 4, unrealRotation],
  ['scale', 3, unrealScale],
]

export function encodeBoneTracks(clip, rig) {
  const tracks = []
  for (const [track, { bone, name }] of clip.mapping.entries()) {
    if (rig.bones[bone]?.name !== name) return null
    for (const [index, [path, stride, convert]] of channels.entries()) {
      const raw = clip.tracks[track][index]
      if (!raw.length) continue
      const length = raw.length / stride
      const count = Math.max(2, length)
      const values = Buffer.alloc(count * stride * 4)
      let previous
      for (let frame = 0; frame < count; frame++) {
        const offset = Math.min(frame, length - 1) * stride
        let key = convert(raw.subarray(offset, offset + stride))
        if (path === 'rotation') {
          const norm = Math.hypot(...key)
          if (norm < 1e-6 || Math.abs(norm - 1) > 0.01) return null
          const negate = previous && key.reduce((sum, value, axis) => sum + value * previous[axis], 0) < 0
          key = key.map(value => value / (negate ? -norm : norm))
          previous = key
        }
        for (const [axis, value] of key.entries()) values.writeFloatLE(value, (frame * stride + axis) * 4)
      }
      tracks.push({ bone, path, stride, count, values })
    }
  }
  return { name: clip.name, duration: clip.duration, frames: clip.frames, tracks }
}

export function animatedSkeleton(rig) {
  const nodes = rig.bones.map(unrealBoneNode)
  for (const [index, bone] of rig.bones.entries()) {
    if (bone.parent >= 0) (nodes[bone.parent].children ??= []).push(index)
  }
  return {
    asset: { version: '2.0', generator: 'Asset Viewer Unreal editor animation' },
    scene: 0, scenes: [{ nodes: [0] }], nodes,
    skins: [{ skeleton: 0, joints: nodes.map((_, index) => index) }],
    accessors: [], bufferViews: [], buffers: [],
  }
}

export function appendEditorAnimations(document, clips, jointNodes) {
  const parts = []
  const buffer = document.buffers.length
  let size = 0
  function accessor(bytes, type, count, bounds) {
    const bufferView = document.bufferViews.push({ buffer, byteOffset: size, byteLength: bytes.length }) - 1
    parts.push(bytes)
    size += bytes.length
    return document.accessors.push({ bufferView, componentType: 5126, count, type, ...bounds }) - 1
  }
  document.animations = clips.map(({ name, duration, tracks }) => {
    const times = new Map()
    const samplers = []
    const channels = tracks.map(({ bone, path, stride, count, values }) => {
      if (!times.has(count)) {
        const keys = Buffer.alloc(count * 4)
        for (let frame = 0; frame < count; frame++) keys.writeFloatLE(duration * frame / (count - 1), 4 * frame)
        times.set(count, accessor(keys, 'SCALAR', count, { min: [0], max: [duration] }))
      }
      const output = accessor(values, 'VEC' + stride, count)
      const sampler = samplers.push({ input: times.get(count), output, interpolation: 'LINEAR' }) - 1
      return { sampler, target: { node: jointNodes[bone], path } }
    })
    return { name, samplers, channels }
  })
  return { parts, size }
}
