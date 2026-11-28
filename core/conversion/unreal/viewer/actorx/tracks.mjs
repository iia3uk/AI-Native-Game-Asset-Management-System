import { actorXKey } from './clips.mjs'

function floats(values) {
  const bytes = Buffer.alloc(values.length * 4)
  for (const [index, value] of values.entries()) bytes.writeFloatLE(value, index * 4)
  return bytes
}

export function actorXTracks(psa, clip, binding, settings, signal) {
  const tracks = []
  for (const [name, bone] of psa.bones) {
    signal?.throwIfAborted()
    const joint = binding.bones.get(name)
    const removed = settings.removed.get(clip.name + '.' + bone.index)
    for (const [path, stride] of [['translation', 3], ['rotation', 4]]) {
      if (removed === 'all' || (path === 'translation' ?
        removed === 'trans' || (settings.rotationOnly && !settings.translation.has(name)) : removed === 'rot')) continue
      const values = Buffer.alloc(clip.count * stride * 4)
      let previous
      for (let frame = 0; frame < clip.count; frame++) {
        const key = actorXKey(psa, clip, bone, frame, path, joint.root, binding.scale)
        if (!key || key.some(value => !Number.isFinite(Math.fround(value)))) return null
        const negate = path === 'rotation' && previous && key.reduce((sum, value, i) => sum + value * previous[i], 0) < 0
        previous = negate ? key.map(value => -value) : key
        for (let index = 0; index < stride; index++) values.writeFloatLE(previous[index], (frame * stride + index) * 4)
      }
      tracks.push({ path, stride, node: joint.node, values })
    }
  }
  if (!tracks.length) return null
  const times = floats(Array.from({ length: clip.count }, (_, frame) => frame / clip.rate))
  return { name: clip.name, frames: clip.count, times, tracks }
}

export function appendActorXAnimations(document, clips, uri) {
  const data = []
  const buffer = document.buffers.length
  let offset = 0
  function accessor(bytes, type, count, bounds) {
    const bufferView = document.bufferViews.length
    document.bufferViews.push({ buffer, byteOffset: offset, byteLength: bytes.length })
    data.push(bytes)
    offset += bytes.length
    document.accessors.push({ bufferView, componentType: 5126, count, type, ...bounds })
    return document.accessors.length - 1
  }
  document.animations = clips.map(({ name, frames, times, tracks }) => {
    const input = accessor(times, 'SCALAR', frames, { min: [0], max: [times.readFloatLE(times.length - 4)] })
    const channels = []
    const samplers = tracks.map(({ path, stride, node, values }, sampler) => {
      channels.push({ sampler, target: { node, path } })
      const output = accessor(values, 'VEC' + stride, frames)
      return { input, output, interpolation: 'LINEAR' }
    })
    return { name, samplers, channels }
  })
  document.buffers.push({ uri, byteLength: offset })
  return data
}
