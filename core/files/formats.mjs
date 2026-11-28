import { watchedFormatByExtension } from '../packages/watch-formats.mjs'

export const browserModels = new Set(['glb', 'gltf', 'vrm', 'fbx', 'obj', 'stl', 'ply', 'dae', '3ds', '3mf',
  'amf', 'kmz', 'lwo', 'wrl', 'vrml', 'vox', 'off', 'vtk', 'vtp', 'pcd', 'xyz', 'bvh', 'drc', 'md2',
  'gcode', 'ldr', 'mpd', 'pdb', '3dm'])
export const blenderModels = new Set(['blend', 'usd', 'usda', 'usdc', 'usdz', 'abc'])
export const modelFormats = new Set([...browserModels, ...blenderModels])
export const browserImages = new Set(['png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'bmp', 'avif', 'ico', 'svg'])
export const imageFormats = new Set([...browserImages, 'tga', 'tif', 'tiff', 'exr', 'hdr', 'dds', 'ktx', 'ktx2', 'pvr', 'psd'])
export const audioFormats = new Set(['wav', 'ogg', 'mp3', 'aif', 'aiff', 'flac'])
export const unityDataFormats = new Set(['asset', 'prefab', 'mat', 'unity', 'anim', 'controller', 'overridecontroller'])
export const supportFiles = new Set(['bin', 'mtl', 'mat', 'meta', 'prefab', 'unity', 'uasset', 'umap', 'psa', 'max', 'c4d',
  'ma', 'mb', 'x3d', 'step', 'stp', 'iges', 'igs', 'mdd', 'dat', 'zip', 'rar', '7z', 'gz', 'tar',
  ...watchedFormatByExtension.keys(), ...unityDataFormats, ...audioFormats])
export const formatOrder = [...new Set(['glb', 'gltf', 'vrm', 'blend', 'fbx', 'obj', 'dae', '3ds', '3mf', 'stl', 'ply',
  ...browserModels, ...blenderModels])]

export function previewCandidates(models) {
  const direct = models.filter(file => file.preview).sort((a, b) => a.size - b.size)
  const geometry = direct.filter(file => !/(?:^|[\\/ _.-])(?:anim(?:ation)?s?|rig)(?:[\\/ _.-]|$)/i.test(file.path))
  return (geometry.length ? geometry : direct).slice(0, 4).map(file => file.id)
}
