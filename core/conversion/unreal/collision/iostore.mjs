import { join } from 'node:path'
import { convexHullIndices } from '../../../engines/unreal/collision/convex-hull.mjs'
import { ioStoreCollisionRevision } from '../../../engines/unreal/decoder/iostore-collision-protocol.mjs'
import { publishSimpleCollision } from './publish.mjs'

export const zenCollisionMethod = 'unreal-iostore-collision'

function normalize({ body, traceMode, doubleSided, buildScale, shapes, omitted }) {
  const result = []
  let missingHull = false
  for (const shape of shapes) {
    const { type, name, collisionEnabled, restOffset, generated, contributesToMass, center, rotation, dimensions, radius,
      length, vertices, indices, transform } = shape
    const base = { type, name: name ?? undefined, collisionEnabled: collisionEnabled ?? undefined,
      restOffset, generated: generated ?? undefined, contributesToMass: contributesToMass ?? undefined }
    if (type === 'convex') {
      const { rotation, translation, scale } = transform
      try {
        result.push({ ...base, vertices, indices: indices ?? convexHullIndices(vertices),
          ...(indices == null && { indexSource: 'convex-hull' }), transform: { rotation, translation, scale } })
      } catch (error) {
        if (!(error instanceof RangeError)) throw error
        missingHull = true
      }
    } else if (type === 'box') result.push({ ...base, center, rotation, dimensions })
    else if (type === 'sphere') result.push({ ...base, center, radius })
    else result.push({ ...base, center, rotation, radius, length })
  }
  const omissions = omitted.map(({ field, index }) => ({ field, index: index ?? undefined }))
  if (missingHull && !omissions.some(row => row.field === 'ConvexElems' && row.index === undefined)) {
    omissions.push({ field: 'ConvexElems' })
  }
  return { body, traceMode: traceMode ?? undefined, doubleSided: doubleSided ?? undefined, buildScale,
    shapes: result, omitted: omissions }
}

export async function publishIoStoreCollision(entries, rows, { workspace, store, signal }) {
  const summary = { assets: 0, shapes: 0, glb: 0, incomplete: 0 }
  const scratch = join(workspace, 'collision-publication')
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted()
    const { collision, collisionIssue } = rows[index]
    if ((!collision && !collisionIssue) || !entry.artifact?.path) continue
    const asset = { id: entry.id, sourcePath: entry.path, output: entry.artifact.path, exports: entry.exports ??= [] }
    const issue = await publishSimpleCollision(asset, { issue: collisionIssue, collision: collision && normalize(collision) },
      { scratch, store, summary, signal, method: zenCollisionMethod, converterVersion: ioStoreCollisionRevision })
    if (issue) {
      entry.collisionIssue = issue
      const issues = entry.issues ??= []
      issues.push(issue)
    }
  }
  return Object.values(summary).some(Boolean) ? summary : null
}
