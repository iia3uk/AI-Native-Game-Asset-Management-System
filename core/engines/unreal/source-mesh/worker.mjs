import { parentPort, workerData } from 'node:worker_threads'
import { encodeSourceMesh } from '../../../conversion/unreal/source-mesh/gltf.mjs'
import { sourceMeshLods } from './mesh-description.mjs'
import { staticMeshPackage } from './package.mjs'

const input = workerData.bytes
const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
const mesh = staticMeshPackage(bytes)
if (!mesh) {
  parentPort.postMessage(null)
} else {
  const meshes = []
  try {
    const { materials, missing, lods } = sourceMeshLods(bytes, mesh)
    for (const { lod, data } of lods()) {
      const name = mesh.name + (lod ? '_Lod' + lod : '')
      const model = encodeSourceMesh(data, { name, bin: workerData.stem + (lod ? '_Lod' + lod : '') + '.bin', materials })
      meshes.push({ lod, ...model })
    }
    parentPort.postMessage({ meshes, missing }, meshes.map(item => item.buffer.buffer))
  } catch {
    parentPort.postMessage({ meshes, issue: 'unreal-source-mesh-layout' }, meshes.map(item => item.buffer.buffer))
  }
}
