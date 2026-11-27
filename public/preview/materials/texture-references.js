export const textureUrls = new WeakMap()
export const fbxTextureRequests = new WeakMap()
export const missingColorMaps = new WeakMap()
export const textureUrl = texture => textureUrls.get(texture) ?? texture?.image?.src
