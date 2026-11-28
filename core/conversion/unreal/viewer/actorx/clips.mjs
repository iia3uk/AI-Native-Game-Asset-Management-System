const decoder = new TextDecoder('utf-8', { fatal: true })
export const maxClipBytes = 16 * 1024 ** 2
export const maxSettingsBytes = 64 * 1024

function name(data, offset) {
  const bytes = data.subarray(offset, offset + 64)
  const end = bytes.indexOf(0)
  if (end <= 0) return null
  try {
    const value = decoder.decode(bytes.subarray(0, end))
    return /[\x00-\x1f\x7f]/u.test(value) ? null : value
  } catch { return null }
}

function vector(data, offset, size) {
  const values = Array.from({ length: size }, (_, index) => data.readFloatLE(offset + index * 4))
  return values.every(Number.isFinite) ? values : null
}

function quaternion(data, offset) {
  const values = vector(data, offset, 4)
  const length = values && Math.hypot(...values)
  return length > .99 && length < 1.01 ? values.map(value => value / length) : null
}

export function actorXClips(data) {
  if (data.length < 128 || data.length > maxClipBytes) return null
  let offset = 0
  const read = (id, stride, max) => {
    if (offset + 32 > data.length || data.toString('ascii', offset, offset + 20).split('\0')[0] !== id ||
        data.readInt32LE(offset + 24) !== stride) return null
    const count = data.readInt32LE(offset + 28)
    const start = offset + 32
    if (count < 0 || count > max || start + count * stride > data.length) return null
    offset = start + count * stride
    return { count, start }
  }
  if (data.readInt32LE(20) !== 20100422 || !read('ANIMHEAD', 0, 0)) return null
  const bonesChunk = read('BONENAMES', 120, 512)
  const clipsChunk = read('ANIMINFO', 168, 64)
  const keys = read('ANIMKEYS', 32, Math.floor(maxClipBytes / 32))
  if (!bonesChunk?.count || !clipsChunk?.count || !keys?.count ||
      (offset !== data.length && !read('SCALEKEYS', 16, 0)) || offset !== data.length) return null
  const bones = new Map()
  for (let index = 0; index < bonesChunk.count; index++) {
    const start = bonesChunk.start + index * 120
    const bone = name(data, start)
    const rotation = quaternion(data, start + 76)
    const position = vector(data, start + 92, 3)
    if (!bone || bones.has(bone) || !rotation || !position) return null
    bones.set(bone, { index, position, rotation })
  }
  const clips = new Map()
  let frames = 0
  for (let index = 0; index < clipsChunk.count; index++) {
    const start = clipsChunk.start + index * 168
    const clip = name(data, start)
    const count = data.readInt32LE(start + 164)
    const rate = data.readFloatLE(start + 152)
    if (!clip || clips.has(clip) || data.readInt32LE(start + 128) !== bones.size ||
        data.readInt32LE(start + 156) !== 0 || data.readInt32LE(start + 160) !== frames ||
        !Number.isFinite(rate) || rate < 0 || rate > 1000 || (count > 1 && rate < .001) || count < 1 ||
        (frames + count) * bones.size > keys.count) return null
    clips.set(clip, { name: clip, start: frames, count, rate: rate || 1 })
    frames += count
  }
  return frames * bones.size === keys.count ? { data, bones, clips, keys: keys.start } : null
}

export function actorXSettings(text, { bones, clips }) {
  const translation = new Set()
  const removed = new Map()
  let section = ''
  let rotationOnly = false
  for (const row of text.trim().split(/\r?\n/u)) {
    const line = row.trim()
    if (!line || line.startsWith(';')) continue
    if (['[AnimSet]', '[UseTranslationBoneNames]', '[RemoveTracks]'].includes(line)) {
      section = line
    } else if (section === '[AnimSet]' && /^bAnimRotationOnly=[01]$/.test(line)) {
      rotationOnly = line.endsWith('1')
    } else if (section === '[UseTranslationBoneNames]' && bones.has(line)) {
      translation.add(line)
    } else if (section === '[RemoveTracks]') {
      const change = /^(.+)\.(\d+)=(trans|rot|all)$/.exec(line)
      if (!change || !clips.has(change[1]) || Number(change[2]) >= bones.size) return null
      const code = change[1] + '.' + Number(change[2])
      if (removed.has(code)) return null
      removed.set(code, change[3])
    } else return null
  }
  return { rotationOnly, translation, removed }
}

export function actorXKey({ data, bones, keys }, clip, bone, frame, path, root, scale) {
  const offset = keys + ((clip.start + frame) * bones.size + bone.index) * 32
  if (data.readFloatLE(offset + 28) !== 1) return null
  // Undo ActorX's mirrored key coordinates, then apply UE Viewer's glTF axis and root conventions.
  if (path === 'translation') {
    const position = vector(data, offset, 3)
    return position && [position[0] * scale, position[2] * scale, -position[1] * scale]
  }
  const rotation = quaternion(data, offset + 12)
  if (!rotation) return null
  const [x, y, z, w] = rotation
  return root ? [-x, -z, y, -w] : [x, z, -y, -w]
}
