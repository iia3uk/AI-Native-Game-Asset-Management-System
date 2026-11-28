import { editorSkeletalMeshMethod } from '../../../engines/unreal/source-mesh/run.mjs'

export function editorSkeletalTotalsMatch(assets, summary) {
  let total = 0
  for (const asset of assets) {
    if (!Array.isArray(asset.exports)) return false
    const outputs = asset.exports.filter(item => item.path && item.method === editorSkeletalMeshMethod)
    if (!outputs.length) continue
    const models = outputs.filter(item => item.role === 'skeletal-model' && item.format === 'gltf')
    const buffers = outputs.filter(item => item.role === 'model-buffer' && item.format === 'bin')
    if (models.length !== 1 || buffers.length !== 1) return false
    const [model] = models
    const [buffer] = buffers
    if (model.lod !== 0 || !model.path.endsWith('.gltf') || buffer.path !== model.path.slice(0, -5) + '.bin' ||
        model.from !== asset.output || buffer.from !== asset.output) return false
    total++
  }
  return total === (summary?.skeletalMeshes ?? 0)
}
