import { cookedCollisionRevision } from '../../../engines/unreal/collision/cooked.mjs'
import { cookedCollisionMethod } from './cooked.mjs'

export function collisionTotalsMatch(entries, summary) {
  let assets = 0, shapes = 0, glb = 0, incomplete = 0
  for (const entry of entries) {
    if (entry.collisionIssue) incomplete++
    const products = entry.exports?.filter(file => ['collision-shapes', 'collision-preview'].includes(file.role)) ?? []
    if (products.some(file => file.method !== cookedCollisionMethod || file.converterVersion !== cookedCollisionRevision ||
        file.status !== 'converted' || file.from !== (entry.artifact?.path ?? entry.output))) return false
    const descriptions = products.filter(file => file.role === 'collision-shapes')
    const previews = products.filter(file => file.role === 'collision-preview')
    if (descriptions.length > 1 || previews.length > 1) return false
    const [description] = descriptions
    const [preview] = previews
    if (description) {
      if (description.format !== 'json' || !Number.isInteger(description.shapes) ||
          description.shapes < 0 || description.shapes > 128) return false
      assets++
      shapes += description.shapes
    }
    if (preview) {
      if (preview.format !== 'glb' || !description?.path || preview.settingsPath !== description.path) return false
      glb++
    }
  }
  return assets === (summary?.assets ?? 0) && shapes === (summary?.shapes ?? 0) &&
    glb === (summary?.glb ?? 0) && incomplete === (summary?.incomplete ?? 0)
}
