import { posix } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { publishUnrealGeometry } from '../mesh-artifact.mjs'
import { encodeCookedMesh } from './mesh-data.mjs'

export const cookedMeshMethod = 'cue4parse-cooked-static-mesh'

export async function publishCookedLod(asset, product, { root, scratch, store, folder, converterVersion, signal }) {
  const file = await fileInfo(root, product.file)
  const invalid = 'unreal-cooked-mesh-output'
  if (file?.info.size !== product.size) return { issue: invalid }
  const changed = () => new Error('Staged cooked mesh changed during publication')
  const { prefix } = await readVerifiedFile(root, file, { capture: product.size, changed, signal })
  const stem = posix.basename(asset.sourcePath).slice(0, -7).replace(/[#%]/g, '_') + (product.lod ? '_Lod' + product.lod : '')
  let geometry
  try { geometry = encodeCookedMesh(prefix, product, stem) } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return { issue: invalid }
  }
  if (!geometry) return { issue: invalid }
  const { document, buffer, materialPaths } = geometry
  const identity = { status: 'converted', converterVersion, method: cookedMeshMethod, from: asset.output, lod: product.lod }
  const issues = ['unreal-cooked-mesh-render-data-only']
  if (product.tangentsQuantized) issues.push('unreal-cooked-mesh-tangent-quantized')
  const saved = await publishUnrealGeometry({ asset, scratch, store, stem, document, buffer, folder,
    identity, issues, signal })
  return { ...saved, materialPaths }
}
