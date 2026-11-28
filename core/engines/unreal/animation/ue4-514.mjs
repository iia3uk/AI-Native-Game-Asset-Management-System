import { structArray, taggedProperties } from '../editor-package/properties.mjs'
import { importedPackageObject } from '../editor-package/references.mjs'
import { editorPackage, requireLayout } from '../editor-package/tables.mjs'
import { ue4SkeletonVersions } from '../skeleton/ue4.mjs'

export const editorAnimationRevision = 1
export const editorAnimationFileLimit = 8 * 1024 ** 2
const animationClass = new Set(['AnimSequence'])
const skeletonClass = new Set(['Skeleton'])
const maxBones = 512

function scalar(bytes, fields, name, type, read) {
  const field = fields.get(name)
  requireLayout(field?.type === type && field.size === 4)
  return read.call(bytes, field.start)
}

function rawTracks(bytes, offset, end, frames, count, signal) {
  requireLayout(offset + 4 <= end && bytes.readInt32LE(offset) === count)
  offset += 4
  const tracks = []
  let size = 0
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted()
    const keys = []
    for (const [channel, width] of [12, 16, 12].entries()) {
      requireLayout(offset + 8 <= end && bytes.readInt32LE(offset) === width)
      const length = bytes.readInt32LE(offset + 4)
      offset += 8
      requireLayout((length === frames || length === 1 || (length === 0 && channel === 2)) &&
        offset + length * width <= end)
      const data = new Float32Array(length * (width / 4))
      for (let i = 0; i < data.length; i++) data[i] = bytes.readFloatLE(offset + i * 4)
      requireLayout(data.every(Number.isFinite))
      keys.push(data)
      offset += data.byteLength
      size += data.byteLength
    }
    tracks.push(keys)
  }
  // SourceRawAnimationData is empty and no derived compressed stream is embedded.
  requireLayout(offset + 8 === end && bytes.readInt32LE(offset) === 0 && bytes.readInt32LE(offset + 4) === 0)
  return { tracks, size }
}

export function readEditorAnimation(bytes, tables, signal) {
  if (bytes.length > editorAnimationFileLimit) return null
  let table, object
  try {
    table = tables === undefined ? editorPackage(bytes, 514) : tables
    if (table?.layout.fileVersionUE4 !== 514) return null
    object = table.topLevel(animationClass)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return null
  }
  if (!object) return null
  let skeletonPackage
  try {
    requireLayout(ue4SkeletonVersions(bytes).framework === 30)
    const { end, properties } = taggedProperties(bytes, object.start, object.end, table.nameAt, 514)
    const skeleton = scalar(bytes, properties, 'Skeleton', 'ObjectProperty', bytes.readInt32LE)
    skeletonPackage = importedPackageObject(table.imported, skeleton, skeletonClass)
    const frames = scalar(bytes, properties, 'NumFrames', 'IntProperty', bytes.readInt32LE)
    const duration = scalar(bytes, properties, 'SequenceLength', 'FloatProperty', bytes.readFloatLE)
    requireLayout(frames >= 1 && frames <= 16_384 && Number.isFinite(duration) && duration > 0 && duration <= 3600)
    if (properties.has('AdditiveAnimType') || properties.has('RetargetSource') ||
        properties.has('RetargetSourceAssetReferencePose')) {
      return { skeletonPackage, issue: 'unreal-editor-animation-retargeting' }
    }
    const names = properties.get('AnimationTrackNames')
    requireLayout(names?.type === 'ArrayProperty' && names.inner === 'NameProperty' && names.size >= 4)
    const count = bytes.readInt32LE(names.start)
    requireLayout(count >= 1 && count <= maxBones && names.size === 4 + 8 * count)
    const rows = structArray(bytes, properties.get('TrackToSkeletonMapTable'), table.nameAt, 'TrackToSkeletonMap', maxBones)
    requireLayout(rows.length === count)
    const seen = new Set()
    const mapping = rows.map((row, index) => {
      const bone = scalar(bytes, row, 'BoneTreeIndex', 'IntProperty', bytes.readInt32LE)
      requireLayout(bone >= 0 && bone < maxBones && !seen.has(bone))
      seen.add(bone)
      return { bone, name: table.nameAt(names.start + 4 + 8 * index) }
    })
    // UObject GUID flag, compression skeleton GUID and editor/class strip flags.
    requireLayout(end + 4 <= object.end && bytes.readUInt32LE(end) <= 1)
    const guidAt = end + (bytes.readUInt32LE(end) ? 20 : 4)
    requireLayout(guidAt + 18 <= object.end && bytes.readUInt16LE(guidAt + 16) === 0)
    const skeletonGuid = bytes.toString('hex', guidAt, guidAt + 16)
    const { tracks, size } = rawTracks(bytes, guidAt + 18, object.end, frames, count, signal)
    return { clip: { name: object.name, frames, duration, skeletonPackage, skeletonGuid, mapping, tracks, size } }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return { skeletonPackage, issue: 'unreal-editor-animation-layout' }
  }
}
