import { posix } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { publishUnrealGeometry } from '../mesh-artifact.mjs'
import { encodeCookedSkeletalMesh } from '../skeletal-mesh/cooked-data.mjs'
import { encodeCookedMesh } from './mesh-data.mjs'

export const cookedMeshMethod = 'cue4parse-cooked-static-mesh'
export const cookedSkeletalMeshMethod = 'cue4parse-cooked-skeletal-mesh'

export async function publishCookedLod(asset, product, { root, scratch, store, folder, converterVersion, signal, rig }) {
  const file = await fileInfo(root, product.file)
  const invalid = 'unreal-cooked-mesh-output'
  if (file?.info.size !== product.size) return { issue: invalid }
  const changed = () => new Error('Staged cooked mesh changed during publication')
  const { prefix } = await readVerifiedFile(root, file, { capture: product.size, changed, signal })
  const stem = posix.basename(asset.sourcePath).slice(0, -7).replace(/[#%]/g, '_') + (product.lod ? '_Lod' + product.lod : '')
  const { influences } = product
  let geometry
  try {
    geometry = influences ? encodeCookedSkeletalMesh(prefix, product, rig, stem + '.bin') :
      encodeCookedMesh(prefix, product, stem)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return { issue: invalid }
  }
  if (!geometry) return { issue: invalid }
  const { document, buffer, materialPaths } = geometry
  const identity = { status: 'converted', converterVersion, method: influences ? cookedSkeletalMeshMethod : cookedMeshMethod,
    from: asset.output, lod: product.lod, ...(influences && { influences, sourceFormat: 'FSkeletalMeshLODRenderData' }) }
  const issues = ['unreal-cooked-mesh-render-data-only']
  if (product.tangentsQuantized) issues.push('unreal-cooked-mesh-tangent-quantized')
  if (influences) issues.push('unreal-cooked-skeletal-mesh-morphs-cloth-and-profiles-omitted')
  const saved = await publishUnrealGeometry({ asset, scratch, store, stem, document, buffer,
    folder: influences ? folder + '-skeletal' : folder, role: influences ? 'skeletal-model' : 'model', identity, issues, signal })
  return { ...saved, materialPaths }
}
