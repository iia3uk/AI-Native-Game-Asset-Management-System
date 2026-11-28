import { parentPort, workerData } from 'node:worker_threads'
import { encodeSourceMesh } from '../../../conversion/unreal/source-mesh/gltf.mjs'
import { sourceMeshLods } from './mesh-description.mjs'
import { staticMeshHeader, staticMeshPackage } from './package.mjs'
import { sourceMeshCollision } from './collision.mjs'
import { rawMeshLods } from './raw-mesh/lods.mjs'

const input = workerData.bytes
const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)

async function readSkeletalMesh() {
  const { editorPackage } = await import('../editor-package/tables.mjs')
  const { ue4EditorSkeletalMesh, readUe4EditorSkeletalMesh } = await import('../skeletal-mesh/ue4-514.mjs')
  const { encodeSkeletalMesh } = await import('../../../conversion/unreal/skeletal-mesh/gltf.mjs')
  const table = editorPackage(bytes, workerData.version)
  const object = ue4EditorSkeletalMesh(bytes, workerData.version, table)
  if (!object) return null
  try {
    const data = readUe4EditorSkeletalMesh(bytes, table, object)
    if (data.issue) return { issue: data.issue }
    const model = encodeSkeletalMesh(data, workerData.stem + '.bin', 'Asset Viewer Unreal editor skeletal mesh')
    return { meshes: [{ lod: 0, ...model, influences: data.influences }] }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return { issue: 'unreal-source-skeletal-mesh-layout' }
  }
}

async function readStaticMesh() {
  const mesh = staticMeshPackage(bytes, workerData.version)
  if (!mesh) return null
  const meshes = []
  const result = { meshes }
  try {
    const header = staticMeshHeader(bytes, mesh)
    try {
      const collision = sourceMeshCollision(bytes, mesh, header.bodyIndex)
      if (collision && (collision.shapes.length || collision.omitted.length || collision.traceMode ||
          collision.doubleSided || collision.buildScale.some(value => value !== 1))) {
        result.collision = collision
        if (collision.shapes.length) {
          const { collisionPreview } = await import('../../../conversion/unreal/collision/gltf.mjs')
          const { buffer, omitted, degenerateTriangles } = collisionPreview(collision.shapes)
          Object.assign(collision, { buffer, previewOmitted: omitted, previewDegenerateTriangles: degenerateTriangles })
        }
      }
    } catch {
      result.collisionIssue = 'unreal-source-collision-layout'
    }
    if (workerData.render) {
      const readLods = workerData.version === 514 ? rawMeshLods : sourceMeshLods
      const { materials, missing, lods } = readLods(bytes, mesh, header)
      result.missing = missing
      for (const { lod, data } of lods()) {
        const name = mesh.name + (lod ? '_Lod' + lod : '')
        const model = encodeSourceMesh(data, { name, bin: workerData.stem + (lod ? '_Lod' + lod : '') + '.bin', materials })
        meshes.push({ lod, ...model, rawMesh: Boolean(data.rawMesh) })
      }
    }
  } catch {
    result.issue = 'unreal-source-mesh-layout'
  }
  return result
}

const result = await (workerData.skeletal ? readSkeletalMesh() : readStaticMesh())
const buffers = (result?.meshes ?? []).map(item => item.buffer.buffer)
if (result?.collision?.buffer) buffers.push(result.collision.buffer.buffer)
parentPort.postMessage(result, buffers)
