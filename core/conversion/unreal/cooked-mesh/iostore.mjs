import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ioStoreMeshRevision } from '../../../engines/unreal/decoder/mesh-protocol.mjs'
import { cue4parseVersion } from '../../../engines/unreal/decoder/run.mjs'
import { createViewerDerivatives } from '../viewer/derivatives.mjs'
import { cookedMeshMethod, publishCookedLod } from './geometry.mjs'

export async function publishIoStoreMeshes(entries, rows, { workspace, store, blender, formats, signal }) {
  if (!rows.some(row => row.mesh || row.meshIssue)) return null
  const models = []
  const summary = { meshes: 0, gltf: 0, missingLods: 0, skipped: 0, failed: 0 }
  const converterVersion = cue4parseVersion + '-zen-mesh-' + ioStoreMeshRevision
  const root = join(workspace, 'output')
  const scratch = join(workspace, 'mesh-publication')
  await mkdir(scratch)
  const options = { root, scratch, store, folder: 'unreal-iostore', converterVersion, signal }
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted()
    const { mesh, meshIssue } = rows[index]
    if ((!mesh && !meshIssue) || !entry.artifact?.path) continue
    const exports = entry.exports ??= []
    if (!mesh) {
      exports.push({ status: 'skipped', role: 'model', format: 'gltf', method: cookedMeshMethod, converterVersion,
        from: entry.artifact.path, issue: meshIssue })
      summary.skipped++
      continue
    }
    const asset = { id: entry.id, sourcePath: entry.path, output: entry.artifact.path, exports }
    if (mesh.missing.length) {
      entry.missingLods = mesh.missing
      summary.missingLods += mesh.missing.length
    }
    if (mesh.limited) summary.issue = 'unreal-iostore-mesh-limit'
    const previous = models.length
    for (const product of mesh.lods) {
      const { artifact, issue } = await publishCookedLod(asset, product, options)
      if (artifact?.path) {
        models.push({ asset, artifact })
      } else {
        summary.failed++
        if (!artifact) exports.push({ status: 'failed', role: 'model', format: 'gltf', method: cookedMeshMethod,
          converterVersion, from: asset.output, lod: product.lod, issue })
      }
    }
    if (models.length > previous) summary.meshes++
  }
  if (!summary.meshes && !summary.skipped && !summary.failed) return null
  summary.gltf = models.length
  summary.derivatives = await createViewerDerivatives({ models, store, blender, output: store.root, workspace, formats, signal })
  return summary
}
