import { publishPackedMap } from '../viewer/packed-maps.mjs'
import { publishCookedNormal } from './normal-map.mjs'

export const cookedMaterialPreviewRevision = 1
export const cookedPackedMethod = 'unreal-cooked-packed-texture'
const rgbFormats = new Set(['PF_B8G8R8A8', 'PF_R8G8B8A8', 'PF_DXT1', 'PF_DXT5'])

function packedSourceIssue(texture) {
  if (texture.srgb !== false) return 'unreal-cooked-packed-color-space'
  return rgbFormats.has(texture.pixelFormat) ? null : 'unreal-cooked-packed-format'
}

export function createMaterialPreviews({ workspace, store, signal }) {
  const normal = new Map()
  const packed = new Map()
  const counts = { normalDerivatives: 0, repackedMaps: 0 }
  const settings = { workspace, store, signal, version: cookedMaterialPreviewRevision, counts }
  let failure
  return {
    counts,
    get failure() { return failure },
    async prepare(description, resolve) {
      const normalMap = await publishCookedNormal(description.bindings, { ...settings, resolve, cache: normal })
      const packedMap = await publishPackedMap(description, { ...settings, resolve, cache: packed,
        sourceIssue: packedSourceIssue, method: cookedPackedMethod })
      if (normalMap) description.normalMap = normalMap
      if (packedMap) description.packedMap = packedMap
      if (normalMap?.path) {
        description.limitations = description.limitations.filter(issue => issue !== 'normal-orientation-unverified')
      }
      for (const issue of [normalMap?.issue, packedMap?.issue]) {
        if (!issue) continue
        description.limitations.push(issue)
        if (issue === 'export-space-limit' || issue === 'export-size-limit') failure ??= issue
      }
      return { ...(normalMap?.path && { normalMap: true }), ...(packedMap?.path && { packedMap: true }) }
    },
  }
}
