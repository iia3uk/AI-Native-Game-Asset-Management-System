import { cookedMeshMethod } from './geometry.mjs'

export function meshTotalsMatch(entries, derivatives, summary) {
  const geometry = file => file.role === 'model' && file.format === 'gltf' && file.method === cookedMeshMethod
  const tally = (format, type, status = 'converted') =>
    derivatives.filter(file => file.format === format && file.role === type && file.status === status).length
  const rawModels = derivatives.filter(file => geometry(file) && file.status === 'converted').length
  const models = entries.filter(entry => entry.exports?.some(file => geometry(file) && file.status === 'converted')).length
  return models === (summary?.meshes ?? 0) && rawModels === (summary?.gltf ?? 0) &&
    tally('bin', 'model-buffer') === rawModels &&
    tally('gltf', 'model') === rawModels + (summary?.texturedGltf ?? 0) &&
    tally('gltf', 'model', 'skipped') === (summary?.skipped ?? 0) &&
    tally('glb', 'model') === (summary?.derivatives?.glb ?? 0) &&
    tally('fbx', 'model') === (summary?.derivatives?.fbx ?? 0)
}

export function validModelStatus(file) {
  return ['converted', 'skipped'].includes(file.status) ||
    (file.role === 'model' && file.format === 'fbx' && file.status === 'requires-tool' && file.issue === 'blender-unavailable')
}
