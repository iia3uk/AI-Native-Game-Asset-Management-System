import { posix } from 'node:path'

const stem = path => posix.basename(path).toLowerCase()
const normalSuffix = /[_. -]+(?:normal(?:map)?|nrm|n)$/i
const colorSuffix = /[_. -]+(?:base[ _-]?colou?r|albedo|diffuse|colou?r|d)$/i

export function streamingColor(description, texture) {
  const normal = description.normalMap?.sourcePath
  if (description.surface?.blend !== 'BLEND_Opaque' || typeof normal !== 'string' ||
      !Array.isArray(description.textureStreaming) || !normalSuffix.test(stem(normal))) return null
  const expected = stem(normal).replace(normalSuffix, '')
  const candidates = new Map()
  for (const row of description.textureStreaming) {
    if (typeof row?.path !== 'string' || stem(row.path).replace(colorSuffix, '') !== expected) continue
    if (row.uvChannel !== 0) return null
    const artifact = texture(row.path)
    if (artifact?.sampling?.srgb === true && artifact.sampling.compression === 'TC_Default') {
      candidates.set(row.path, artifact)
    }
  }
  return candidates.size === 1 ? candidates.values().next().value : null
}
