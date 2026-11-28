import { cookedNormalMethod } from './normal-map.mjs'
import { cookedMaterialPreviewRevision, cookedPackedMethod } from './texture-previews.mjs'

export const isCookedPreviewMethod = method => method === cookedNormalMethod || method === cookedPackedMethod

export function cookedMaterialPreviewsMatch(assets, summary, materialMethod) {
  const counts = { normalDerivatives: 0, repackedMaps: 0, normalMaterials: 0, packedMaterials: 0 }
  for (const asset of assets) {
    const products = asset.exports ?? []
    for (const file of products) {
      if (file.method === materialMethod && file.role === 'material' && file.status === 'converted') {
        if (file.normalMap === true) counts.normalMaterials++
        if (file.packedMap === true) counts.packedMaterials++
      }
      if (!isCookedPreviewMethod(file.method)) continue
      const original = products.find(product => product.path === file.from && product.role === 'texture' && product.format === 'png')
      if (file.role !== 'preview-texture' || file.format !== 'png' || file.status !== 'converted' || !file.path ||
          !original?.path || original.srgb !== false || original.width !== file.width || original.height !== file.height ||
          file.converterVersion !== cookedMaterialPreviewRevision || file.colorSpace !== 'linear') return false
      if (file.method === cookedNormalMethod) {
        if (original.normalZReconstructed !== true || original.pixelFormat !== 'PF_BC5' || file.convention !== 'opengl' ||
            file.path !== 'Textures/' + asset.id + '/normal-opengl.png') return false
        counts.normalDerivatives++
      } else {
        if (!['MRA', 'RMA'].includes(file.sourceLayout) || file.layout !== 'ORM' ||
            file.path !== 'Textures/' + asset.id + '/orm-from-' + file.sourceLayout.toLowerCase() + '.png') return false
        counts.repackedMaps++
      }
    }
  }
  return Object.entries(counts).every(([key, value]) => value === (summary?.[key] ?? 0))
}
