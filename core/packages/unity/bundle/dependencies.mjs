import { bundleObjectKey, bundleTarget } from '../../../conversion/unity/materials/bundle-material.mjs'

export function bundleDependencies(assets) {
  const objects = new Map(assets.map(asset => [bundleObjectKey(asset.member, asset.pathId), asset]))
  const entries = assets.filter(asset => asset.sprite).map(({ member, pathId, sprite }) => ({
    type: 'sprite-texture',
    from: { member, pathId },
    to: { member, pathId: sprite.texturePathId },
  }))
  for (const asset of assets) {
    const { member, pathId, material, meshMaterials } = asset
    const from = { member, pathId }
    const link = (reference, classId) => ({
      from,
      to: reference.fileId ? reference : { member, pathId: reference.pathId },
      status: reference.fileId ? 'external' : bundleTarget(objects, member, reference, classId) ? 'resolved' : 'missing',
    })
    for (const { property, texture } of material?.textures ?? []) {
      entries.push({ type: 'material-texture', property, ...link(texture, 28) })
    }
    if (meshMaterials?.status === 'linked') {
      for (const [slot, reference] of meshMaterials.slots.entries()) {
        const edge = reference ? link(reference, 21) : { from, status: 'missing' }
        entries.push({ type: 'mesh-material', slot, ...edge })
      }
    } else if (meshMaterials) {
      entries.push({ type: 'mesh-material', from, status: meshMaterials.status })
    }
  }
  return { version: 1, status: entries.length ? 'partial' : 'unavailable', entries }
}
