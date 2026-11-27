export function hasTextureImage(texture) {
  const image = texture?.image
  if (texture?.isDataTexture && !image?.data?.length) return false
  if (Array.isArray(image)) return image.some(face => face?.width > 0 && face?.height > 0)
  return image?.width > 0 && image?.height > 0
}
