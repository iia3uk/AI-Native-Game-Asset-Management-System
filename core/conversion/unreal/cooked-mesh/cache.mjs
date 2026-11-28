import { cookedMeshMethod, cookedSkeletalMeshMethod } from './geometry.mjs'

const modelRoles = new Set(['model', 'skeletal-model'])

export function cookedSkeletalTotalsMatch(assets, summary) {
  let count = 0
  for (const asset of assets) {
    const artifacts = asset.exports?.filter(file => file.method === cookedSkeletalMeshMethod &&
      file.status === 'converted' && file.format !== 'glb') ?? []
    if (!artifacts.length) continue
    const models = artifacts.filter(file => file.role === 'skeletal-model' && file.format === 'gltf')
    const buffers = artifacts.filter(file => file.role === 'model-buffer' && file.format === 'bin')
    const reference = asset.skeleton
    const source = asset.artifact?.path ?? asset.output
    if (!models.length || artifacts.length !== 2 * models.length || models.length !== buffers.length ||
        reference?.role !== 'skeleton-reference' || new Set(models.map(file => file.lod)).size !== models.length ||
        models.some(file => !file.path?.endsWith('.gltf') || file.metrics?.bones !== reference.bones ||
          !Number.isInteger(file.lod) || file.lod < 0 || file.lod > 7 || file.from !== source ||
          ![4, 8].includes(file.influences) || !buffers.some(buffer => buffer.from === source && buffer.lod === file.lod &&
            buffer.path === file.path.slice(0, -5) + '.bin' && buffer.influences === file.influences))) return false
    count++
  }
  return count === (summary?.skeletalMeshes ?? 0)
}

export function meshTotalsMatch(entries, derivatives, summary) {
  const geometry = file => file.format === 'gltf' && (file.role === 'model' && file.method === cookedMeshMethod ||
    file.role === 'skeletal-model' && file.method === cookedSkeletalMeshMethod)
  const tally = (format, status = 'converted') =>
    derivatives.filter(file => file.format === format && modelRoles.has(file.role) && file.status === status).length
  const rawModels = derivatives.filter(file => geometry(file) && file.status === 'converted').length
  const models = entries.filter(entry => entry.exports?.some(file => geometry(file) && file.status === 'converted')).length
  return models === (summary?.meshes ?? 0) && rawModels === (summary?.gltf ?? 0) &&
    cookedSkeletalTotalsMatch(entries, summary) &&
    derivatives.filter(file => file.format === 'bin' && file.role === 'model-buffer' && file.status === 'converted').length === rawModels &&
    tally('gltf') === rawModels + (summary?.texturedGltf ?? 0) &&
    tally('gltf', 'skipped') === (summary?.skipped ?? 0) &&
    tally('glb') === (summary?.derivatives?.glb ?? 0) &&
    tally('fbx') === (summary?.derivatives?.fbx ?? 0)
}

export function validModelStatus(file) {
  return ['converted', 'skipped'].includes(file.status) ||
    (modelRoles.has(file.role) && file.format === 'fbx' && file.status === 'requires-tool' && file.issue === 'blender-unavailable')
}
