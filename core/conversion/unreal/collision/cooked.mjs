import { mkdir } from 'node:fs/promises'
import { posix } from 'node:path'
import { cookedCollisionRevision, readCookedCollision } from '../../../engines/unreal/collision/cooked.mjs'
import { collisionPreview } from './gltf.mjs'
import { publishCollision } from './publish.mjs'

export const cookedCollisionMethod = 'unreal-cooked-collision'

export async function publishCookedCollision(input, table, mesh, { output, scratch, store, summary, signal }) {
  const result = await readCookedCollision(output, input, table, mesh, signal)
  if (!result) return
  const { asset } = input
  const collision = result.collision
  let issue = result.issue
  if (collision) {
    const { buffer, omitted, degenerateTriangles } = collisionPreview(collision.shapes)
    const stem = posix.basename(asset.sourcePath).slice(0, -7).replace(/[#%]/g, '_')
    await mkdir(scratch, { recursive: true })
    const saved = await publishCollision({ asset, scratch, stem, store, signal, method: cookedCollisionMethod,
      converterVersion: cookedCollisionRevision, collision: { ...collision, buffer, previewOmitted: omitted,
        previewDegenerateTriangles: degenerateTriangles } })
    if (saved.description?.path) {
      summary.assets++
      summary.shapes += collision.shapes.length
    }
    if (saved.preview?.path) summary.glb++
    if (saved.issue) summary.failed = (summary.failed ?? 0) + 1
    issue = saved.issue ?? ((omitted.length || collision.omitted.length) ? 'unreal-cooked-collision-partial' : null)
  }
  if (issue) {
    if (result.issue === 'unreal-cooked-collision-read') summary.failed = (summary.failed ?? 0) + 1
    asset.collisionIssue = issue
    asset.issues.push(issue)
    summary.incomplete++
  }
}
