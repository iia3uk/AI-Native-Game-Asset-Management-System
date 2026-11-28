import { cookedCollisionRevision, readCookedCollision } from '../../../engines/unreal/collision/cooked.mjs'
import { publishSimpleCollision } from './publish.mjs'

export const cookedCollisionMethod = 'unreal-cooked-collision'

export async function publishCookedCollision(input, table, mesh, { output, scratch, store, summary, signal }) {
  const result = await readCookedCollision(output, input, table, mesh, signal)
  if (!result) return
  const { asset } = input
  const issue = await publishSimpleCollision(asset, result, { scratch, store, summary, signal,
    method: cookedCollisionMethod, converterVersion: cookedCollisionRevision })
  if (issue) {
    if (result.issue === 'unreal-cooked-collision-read') summary.failed = (summary.failed ?? 0) + 1
    asset.collisionIssue = issue
    asset.issues.push(issue)
  }
}
