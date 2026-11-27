export function disposeModel(object) {
  const geometry = new Set()
  const materials = new Set()
  const textures = new Set()
  const skeletons = new Set()
  object.traverse(item => {
    for (const texture of item.userData.replacedTextures ?? []) textures.add(texture)
    if (item.geometry) geometry.add(item.geometry)
    if (item.skeleton) skeletons.add(item.skeleton)
    for (const material of Array.isArray(item.material) ? item.material : item.material ? [item.material] : []) {
      if (!material) continue
      materials.add(material)
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
    }
  })
  for (const item of [...geometry, ...materials, ...textures, ...skeletons]) item.dispose()
  if (typeof ImageBitmap !== 'undefined') {
    const bitmaps = new Set([...textures].map(texture => texture.image).filter(image => image instanceof ImageBitmap))
    for (const bitmap of bitmaps) bitmap.close()
  }
}
