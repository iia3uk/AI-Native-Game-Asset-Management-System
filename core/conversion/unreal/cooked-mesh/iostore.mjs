import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ioStoreMeshRevision } from '../../../engines/unreal/decoder/mesh-protocol.mjs'
import { cue4parseVersion } from '../../../engines/unreal/decoder/run.mjs'
import { readBoundedText } from '../../../files/asset-files.mjs'
import { zenMaterialMethod } from '../cooked-material/iostore.mjs'
import { publishTexturedViewerModels } from '../viewer/bind-materials.mjs'
import { createViewerDerivatives } from '../viewer/derivatives.mjs'
import { cookedMeshMethod, publishCookedLod } from './geometry.mjs'

export async function publishIoStoreMeshes(entries, rows, { workspace, store, blender, formats, signal,
  resolve, dependencies }) {
  if (!rows.some(row => row.mesh || row.meshIssue)) return null
  const models = []
  const descriptions = new Map()
  const summary = { meshes: 0, gltf: 0, missingLods: 0, skipped: 0, failed: 0 }
  const converterVersion = cue4parseVersion + '-zen-mesh-' + ioStoreMeshRevision
  const root = join(workspace, 'output')
  const scratch = join(workspace, 'mesh-publication')
  await mkdir(scratch)
  const options = { root, scratch, store, folder: 'unreal-iostore', converterVersion, signal }
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted()
    const { mesh, meshIssue, meshMaterials } = rows[index]
    if ((!mesh && !meshIssue) || !entry.artifact?.path) continue
    const exports = entry.exports ??= []
    if (!mesh) {
      exports.push({ status: 'skipped', role: 'model', format: 'gltf', method: cookedMeshMethod, converterVersion,
        from: entry.artifact.path, issue: meshIssue })
      summary.skipped++
      continue
    }
    const asset = { id: entry.id, sourcePath: entry.path, output: entry.artifact.path, exports, issues: [] }
    const paths = new Map()
    for (const { slot, reference } of meshMaterials ?? []) {
      const target = resolve(reference, 'material')
      paths.set(slot, target?.path ?? null)
      dependencies.push({ source: entry.id, target: target?.id ?? null, path: target?.path ?? reference.package,
        reference, type: 'unreal-model-material', status: target ? 'resolved' : 'missing', slot })
      if (!target || descriptions.has(target.path)) continue
      const artifact = target.exports.find(product => product.path && product.method === zenMaterialMethod)
      const text = artifact && await readBoundedText(store.root, artifact.path, 4 * 1024 ** 2)
      descriptions.set(target.path, text ? { asset: target, description: JSON.parse(text) } : null)
    }
    if (mesh.missing.length) {
      entry.missingLods = mesh.missing
      summary.missingLods += mesh.missing.length
    }
    if (mesh.limited) summary.issue = 'unreal-iostore-mesh-limit'
    const previous = models.length
    for (const lod of mesh.lods) {
      const product = paths.size ? { ...lod,
        sections: lod.sections.map(section => ({ ...section, material: paths.get(section.slot) ?? null })) } : lod
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
  if (descriptions.size) {
    const counts = { texturedGltf: 0 }
    await publishTexturedViewerModels({ models, counts, output: store.root, workspace, store, signal,
      method: 'unreal-cooked-mesh-material-binding', materialByPath: path => descriptions.get(path) })
    if (counts.texturedGltf) summary.texturedGltf = counts.texturedGltf
    if (models.some(({ asset }) => asset.issues.length)) summary.issue = 'unreal-iostore-mesh-material-output'
  }
  summary.derivatives = await createViewerDerivatives({ models, store, blender, output: store.root, workspace, formats, signal })
  return summary
}
