export const browserModels = new Set(['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae', '3ds', '3mf'])
export const modelFormats = new Set([...browserModels, 'blend'])
export const browserImages = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico'])
export const imageFormats = new Set([...browserImages, 'tga', 'tif', 'tiff', 'exr', 'hdr', 'dds', 'ktx2', 'psd'])
export const supportFiles = new Set(['bin', 'mtl', 'mat', 'meta', 'prefab', 'unity', 'uasset', 'umap', 'max', 'c4d',
  'usd', 'usda', 'usdc', 'usdz', 'abc', 'kmz', 'lwo', 'off', 'amf', 'zip', 'rar', '7z', 'unitypackage', 'gz', 'tar'])
export const formatOrder = ['glb', 'gltf', 'blend', 'fbx', 'obj', 'dae', '3ds', '3mf', 'stl', 'ply']

export function previewCandidates(models) {
  const direct = models.filter(file => file.preview).sort((a, b) => a.size - b.size)
  const geometry = direct.filter(file => !/(?:^|[\\/ _.-])(?:anim(?:ation)?s?|rig)(?:[\\/ _.-]|$)/i.test(file.path))
  return (geometry.length ? geometry : direct).slice(0, 4).map(file => file.id)
}
