import { animationSkeletonDependency, editorAnimationBindingMethod, editorAnimationMethod, editorClipPath,
  modelAnimationDependency } from './binding.mjs'

export function animationTotalsMatch(assets, summary, dependencies) {
  if (!Array.isArray(dependencies)) return false
  const clips = new Set()
  const models = new Map()
  for (const asset of assets) {
    const standalone = asset.exports.filter(item => item.path && item.method === editorAnimationMethod)
    if (standalone.length) {
      const [clip] = standalone
      if (standalone.length !== 1 || clip.from !== asset.output || clip.format !== 'glb' || clip.role !== 'animation' ||
          clip.path !== editorClipPath(asset)) return false
      clips.add(asset.id)
    }
    const bound = asset.exports.filter(item => item.path && item.method === editorAnimationBindingMethod)
    if (!bound.length) continue
    const model = bound.find(item => item.format === 'gltf' && item.role === 'skeletal-model')
    const bin = bound.find(item => item.format === 'bin' && item.role === 'animation-buffer')
    if (bound.length !== 2 || !model || !bin || bin.path !== model.path.replace(/\.gltf$/, '.bin') ||
        bin.sourceModel !== model.sourceModel || bin.from !== model.from ||
        !asset.exports.some(item => item.path === model.sourceModel && item.role === 'skeletal-model') ||
        !Number.isSafeInteger(model.metrics?.animations) || model.metrics.animations <= 0) return false
    models.set(asset.id, model.metrics.animations)
  }
  const linked = new Set()
  const bindings = new Map()
  const ids = new Set(assets.filter(asset => asset.skeleton?.role === 'skeleton').map(asset => asset.id))
  let bindingCount = 0
  for (const { source, target, status, type } of dependencies) {
    if (status !== 'resolved') continue
    if (type === animationSkeletonDependency) {
      if (!ids.has(target) || linked.has(source)) return false
      linked.add(source)
    }
    if (type === modelAnimationDependency) {
      if (!models.has(source) || !clips.has(target)) return false
      const group = bindings.get(source) ?? new Set()
      if (group.has(target)) return false
      group.add(target)
      bindings.set(source, group)
      bindingCount++
    }
  }
  return clips.size === (summary?.clips ?? 0) && [...clips].every(id => linked.has(id)) &&
    models.size === (summary?.models ?? 0) && [...models].every(([id, count]) => bindings.get(id)?.size === count) &&
    bindingCount === (summary?.bindings ?? 0)
}
