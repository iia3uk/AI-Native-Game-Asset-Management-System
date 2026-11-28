import { mkdir, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { modelArtifact } from '../../artifacts.mjs'
import { collisionPreview } from './gltf.mjs'

export async function publishSimpleCollision(asset, { collision, issue }, { scratch, store, summary, signal, method, converterVersion }) {
  if (collision) {
    const { buffer, omitted, degenerateTriangles } = collisionPreview(collision.shapes)
    const stem = posix.basename(asset.sourcePath).slice(0, -7).replace(/[#%]/g, '_')
    await mkdir(scratch, { recursive: true })
    const saved = await publishCollision({ asset, scratch, stem, store, signal, method, converterVersion,
      collision: { ...collision, buffer, previewOmitted: omitted, previewDegenerateTriangles: degenerateTriangles } })
    if (saved.description?.path) {
      summary.assets++
      summary.shapes += collision.shapes.length
    }
    if (saved.preview?.path) summary.glb++
    if (saved.issue) summary.failed = (summary.failed ?? 0) + 1
    issue = saved.issue ?? ((omitted.length || collision.omitted.length) ? method + '-partial' : null)
  }
  if (issue) summary.incomplete++
  return issue
}

export async function publishCollision({ asset, collision, scratch, stem, store, method, converterVersion, signal }) {
  const { buffer, previewOmitted, ...shapes } = collision
  const metadata = JSON.stringify({ version: 1, sourcePath: asset.sourcePath, axisOrder: 'Unreal XYZ',
    lengthUnit: 'cm', rotationUnit: 'degrees', quaternionOrder: 'xyzw', ...shapes, previewOmitted }, null, 2) + '\n'
  const issue = await store.preflight(Buffer.byteLength(metadata) + (buffer?.byteLength ?? 0))
  if (issue) return { issue }
  const metadataPath = join(scratch, 'collision.json')
  await writeFile(metadataPath, metadata, { signal })
  const details = { method, ...(converterVersion !== undefined && { converterVersion }), status: 'converted', from: asset.output }
  const description = await store.save('Metadata/' + asset.id + '/collision.json',
    { path: metadataPath, info: { size: Buffer.byteLength(metadata) } },
    { ...details, format: 'json', role: 'collision-shapes', shapes: shapes.shapes.length })
  asset.exports.push(description)
  if (!description.path) return { issue: description.issue }
  let preview
  if (buffer) {
    const name = stem + '-Collision.glb'
    const filename = Buffer.byteLength(name) <= 255 ? name : 'Collision.glb'
    await writeFile(join(scratch, 'Collision.glb'), buffer, { signal })
    const verified = await modelArtifact(scratch, 'Collision.glb', 'glb', signal)
    if (!verified) return { description, issue: method + '-preview' }
    preview = await store.save('Previews/' + asset.id + '/' + filename, verified,
      { ...details, format: 'glb', role: 'collision-preview', settingsPath: description.path })
    asset.exports.push(preview)
  }
  return { description, preview, issue: preview?.issue }
}
