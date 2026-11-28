import { requireLayout } from '../package-tables.mjs'
import { readEditorMeshReference, ue4SkeletonVersions } from '../skeleton/ue4.mjs'
import { readSoftSkinVertex, softSkinVertexSize } from './soft-vertices.mjs'

const skeletalMeshClass = new Set(['SkeletalMesh'])
const maxVertices = 500_000
const maxIndices = 3_000_000

export function ue4EditorSkeletalMesh(bytes, version, table) {
  if (version !== 514) return null
  const object = table?.topLevel(skeletalMeshClass)
  if (!object) return null
  const { editor, skeletal, rendering, tangent, core = 0, fortnite = 0 } = ue4SkeletonVersions(bytes)
  return editor === 20 && skeletal === 10 && rendering === 20 && tangent === 1 && core === 0 && fortnite === 0 ?
    object : null
}

export function readUe4EditorSkeletalMesh(bytes, table, object) {
  const { payload, rig, materials, properties, end } = readEditorMeshReference(bytes, table, object)
  let at = end
  function take(size) {
    requireLayout(Number.isSafeInteger(size) && size >= 0 && size <= payload.length - at)
    const start = at
    at += size
    return start
  }
  function count(maximum) {
    const value = payload.readInt32LE(take(4))
    requireLayout(value >= 0 && value <= maximum)
    return value
  }
  function boneIndices(maximum) {
    const length = count(maximum)
    const start = take(length * 2)
    const values = Array.from({ length }, (_, index) => payload.readUInt16LE(start + index * 2))
    requireLayout(values.every(index => index < rig.bones.length) && new Set(values).size === length)
    return values
  }
  function stripFlags() {
    requireLayout(payload.readUInt16LE(take(2)) === 0)
  }
  const lodCount = count(16)
  if (lodCount !== 1) return { issue: 'unreal-source-skeletal-mesh-lod-layout' }
  stripFlags()
  const sections = []
  const sectionCount = count(128)
  let vertexCount = 0
  let indexCount = 0
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
    stripFlags()
    const header = take(30)
    const slot = payload.readInt16LE(header)
    const baseIndex = payload.readInt32LE(header + 2)
    const triangles = payload.readInt32LE(header + 6)
    requireLayout(slot >= 0 && slot < materials.length && baseIndex === indexCount && triangles > 0 &&
      triangles * 3 <= maxIndices - indexCount)
    const legacyCloth = payload.readUInt32LE(header + 11)
    const linkedClothSection = payload.readInt16LE(header + 15)
    requireLayout(legacyCloth === 0 && linkedClothSection === -1 && payload.readUInt32LE(header + 18) <= 1 &&
      payload.readUInt32LE(header + 22) <= 1 && payload.readUInt32LE(header + 26) === vertexCount)

    const vertices = count(maxVertices - vertexCount)
    requireLayout(vertices > 0)
    const vertexStart = take(vertices * softSkinVertexSize)
    const bones = boneIndices(256)
    // NumVertices duplicates the soft vertex count. The section palette addresses the global reference skeleton.
    requireLayout(bones.length > 0 && count(maxVertices) === vertices)
    const influences = count(8)
    requireLayout(influences > 0 && count(0) === 0 && count(0) === 0 && count(0) === 0)
    take(2) // Deprecated clothing asset index is uninitialized in this layout.
    const clothing = take(20)
    requireLayout(payload.subarray(clothing, clothing + 16).every(value => value === 0) &&
      payload.readInt32LE(clothing + 16) === -1)
    sections.push({ slot, baseIndex, triangles, vertexStart, baseVertex: vertexCount, vertices, bones, influences })
    vertexCount += vertices
    indexCount += triangles * 3
  }
  requireLayout(vertexCount > 0 && indexCount > 0)

  const indexWidth = payload[take(1)]
  requireLayout((indexWidth === 2 || indexWidth === 4) && count(4) === indexWidth && count(maxIndices) === indexCount)
  const indexStart = take(indexCount * indexWidth)
  boneIndices(rig.bones.length) // ActiveBoneIndices.
  take(4) // Obsolete LOD size field.
  requireLayout(count(maxVertices) === vertexCount)
  boneIndices(rig.bones.length) // RequiredBones.
  // RawPointIndices is an out-of-line editor table. Geometry uses the validated section index buffer.
  const bulk = take(20)
  requireLayout(payload.readUInt32LE(bulk) === 1 && payload.readInt32LE(bulk + 4) >= 0 &&
    payload.readInt32LE(bulk + 8) === payload.readInt32LE(bulk + 4) * 4)
  const imported = count(vertexCount)
  requireLayout(imported === 0 || imported === vertexCount)
  take(imported * 4 + 4) // MeshToImportVertexMap and MaxImportVertex.
  const uvCount = count(4)
  requireLayout(uvCount > 0)

  const colors = properties.get('bHasVertexColors')
  if (colors) requireLayout(colors.type === 'BoolProperty' && colors.value <= 1)
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const tangents = new Float32Array(vertexCount * 4)
  const color = colors?.value ? new Uint8Array(vertexCount * 4) : null
  const uvs = Array.from({ length: uvCount }, () => new Float32Array(vertexCount * 2))
  const extraInfluences = sections.some(section => section.influences > 4)
  const joints = Array.from({ length: extraInfluences ? 2 : 1 }, () => new Uint16Array(vertexCount * 4))
  const weights = joints.map(() => new Uint8Array(vertexCount * 4))
  const fields = { positions, normals, tangents, color, uvs, joints, weights }
  for (const section of sections) {
    for (let local = 0; local < section.vertices; local++) {
      readSoftSkinVertex(payload, section.vertexStart + local * softSkinVertexSize, section.baseVertex + local, section, fields)
    }
    const IndexArray = indexWidth === 2 && section.vertices < 65536 ? Uint16Array : Uint32Array
    const indices = new IndexArray(section.triangles * 3)
    for (let index = 0; index < indices.length; index++) {
      const value = payload.readUIntLE(indexStart + (section.baseIndex + index) * indexWidth, indexWidth)
      requireLayout(value >= section.baseVertex && value < section.baseVertex + section.vertices)
      indices[index] = value - section.baseVertex
    }
    section.indices = indices
  }
  return { rig, materials, sections, fields, influences: Math.max(...sections.map(section => section.influences)) }
}
