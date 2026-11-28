import { maxReferenceBones } from '../../../engines/unreal/skeleton/reference.mjs'
import { ue4SkeletonRevision } from '../../../engines/unreal/skeleton/ue4.mjs'
import { skeletonDependency, skeletonMethod } from './publish.mjs'

export const skeletonRoles = new Set(['skeleton', 'skeleton-reference'])

export function skeletonTotalsMatch(assets, summary, dependencies) {
  if (!Array.isArray(dependencies) || (summary && summary.converterVersion !== ue4SkeletonRevision)) return false
  const descriptions = new Map()
  let skeletons = 0, meshReferencePoses = 0, incomplete = 0
  for (const asset of assets) {
    if (asset.issues?.some(issue => issue.startsWith('unreal-ue4-skeleton-'))) incomplete++
    const files = asset.exports?.filter(file => file.method === skeletonMethod ||
      file.path && file.path === asset.skeleton?.path) ?? []
    if (files.length !== Number(Boolean(asset.skeleton))) return false
    const [file] = files
    if (!file) continue
    if (file.method !== skeletonMethod || !skeletonRoles.has(file.role) ||
        file.converterVersion !== ue4SkeletonRevision || file.status !== 'converted' ||
        file.format !== 'json' || file.from !== (asset.artifact?.path ?? asset.output) ||
        file.path !== 'Metadata/Skeletons/' + asset.id + '/reference.json' ||
        file.path !== asset.skeleton.path || file.role !== asset.skeleton.role || file.bones !== asset.skeleton.bones ||
        !Number.isInteger(file.bones) || file.bones < 1 || file.bones > maxReferenceBones) return false
    descriptions.set(asset.id, file.role)
    if (file.role === 'skeleton') skeletons++
    else meshReferencePoses++
  }
  const refs = new Set()
  let linked = 0
  for (const row of dependencies) {
    if (row.type !== skeletonDependency) continue
    if (descriptions.get(row.source) !== 'skeleton-reference' || refs.has(row.source) ||
        !['resolved', 'unavailable', 'missing'].includes(row.status)) return false
    refs.add(row.source)
    if (row.status === 'resolved') {
      if (descriptions.get(row.target) !== 'skeleton') return false
      linked++
    }
  }
  return skeletons === (summary?.skeletons ?? 0) && meshReferencePoses === (summary?.meshReferencePoses ?? 0) &&
    linked === (summary?.linked ?? 0) && incomplete === (summary?.incomplete ?? 0)
}
