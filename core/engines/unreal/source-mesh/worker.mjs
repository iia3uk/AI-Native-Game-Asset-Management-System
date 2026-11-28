import { parentPort, workerData } from 'node:worker_threads'
import { encodeSourceMesh } from '../../../conversion/unreal/source-mesh/gltf.mjs'
import { sourceMeshLods } from './mesh-description.mjs'
import { staticMeshHeader, staticMeshPackage } from './package.mjs'
import { sourceMeshCollision } from './collision.mjs'

const input = workerData.bytes
const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
const mesh = staticMeshPackage(bytes)
if (!mesh) {
  parentPort.postMessage(null)
} else {
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
      const { materials, missing, lods } = sourceMeshLods(bytes, mesh, header)
      for (const { lod, data } of lods()) {
        const name = mesh.name + (lod ? '_Lod' + lod : '')
        const model = encodeSourceMesh(data, { name, bin: workerData.stem + (lod ? '_Lod' + lod : '') + '.bin', materials })
        meshes.push({ lod, ...model })
      }
      result.missing = missing
    }
  } catch {
    result.issue = 'unreal-source-mesh-layout'
  }
  const buffers = meshes.map(item => item.buffer.buffer)
  if (result.collision?.buffer) buffers.push(result.collision.buffer.buffer)
  parentPort.postMessage(result, buffers)
}
