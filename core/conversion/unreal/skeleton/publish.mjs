import { mkdir, writeFile } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import { unrealGameAssetResolver } from '../../../engines/unreal/editor-package/game-path.mjs'
import { extractCookedSkeleton, ue4SkeletonRevision } from '../../../engines/unreal/skeleton/ue4.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { ExportArtifacts } from '../../artifacts.mjs'

const maxRigs = 512
export const skeletonMethod = 'unreal-ue4-reference-skeleton'
export const skeletonDependency = 'unreal-skeletal-mesh-skeleton'
const limitations = ['unreal-skeleton-metadata-only']
const maxBytes = 64 * 1024 ** 2
const objectKey = name => name.normalize('NFC').toLowerCase()

export function createSkeletonPublisher({ records, output, workspace, source, signal,
  resolve = unrealGameAssetResolver(records.assets, source.root), store = new ExportArtifacts(output, signal, maxBytes) }) {
  const scratch = join(workspace, 'unreal-skeletons')
  const byOutput = new Map(records.assets.filter(asset => asset.output).map(asset => [asset.output, asset]))
  const published = new Map()
  const summary = { converterVersion: ue4SkeletonRevision, skeletons: 0, meshReferencePoses: 0, linked: 0, incomplete: 0 }
  let written = 0

  async function publish(asset, result, companion) {
    if (!result) return
    if (result.issue) {
      asset.issues.push(result.issue)
      summary.incomplete++
      return
    }
    if (published.size >= maxRigs) {
      summary.issue = 'unreal-skeleton-count-limit'
      return
    }
    const { rig } = result
    const standalone = rig.objectClass === 'Skeleton'
    const role = standalone ? 'skeleton' : 'skeleton-reference'
    const relative = 'Metadata/Skeletons/' + asset.id + '/reference.json'
    const description = {
      version: 1, method: skeletonMethod, converterVersion: ue4SkeletonRevision,
      source: { id: asset.id, path: asset.sourcePath, sha256: asset.hash, storage: asset.storage,
        ...(companion && { companion: { path: companion.sourcePath, sha256: companion.hash } }) },
      units: 'centimeters', coordinates: 'unreal', ...rig, limitations,
    }
    const bytes = Buffer.from(JSON.stringify(description, null, 2) + '\n')
    const issue = written + bytes.length > maxBytes ? 'unreal-skeleton-size-limit' : await store.preflight(bytes.length)
    if (issue) {
      asset.issues.push(issue)
      summary.issue = issue
      return
    }
    const path = join(scratch, asset.id + '.json')
    await mkdir(scratch, { recursive: true })
    await writeFile(path, bytes, { flag: 'wx', signal })
    const artifact = await store.save(relative, { path, info: { size: bytes.length } }, {
      from: asset.output, status: 'converted', format: 'json', role, method: skeletonMethod,
      converterVersion: ue4SkeletonRevision, bones: rig.bones.length, issues: limitations,
    })
    asset.exports.push(artifact)
    if (!artifact.path) {
      summary.issue = artifact.issue
      return
    }
    written += bytes.length
    asset.skeleton = { path: artifact.path, role, bones: rig.bones.length }
    published.set(asset.id, { asset, rig, role })
    if (standalone) {
      summary.skeletons++
      asset.status = 'converted'
    } else summary.meshReferencePoses++
  }

  async function publishCooked(input, table) {
    const result = await extractCookedSkeleton(output, input, table, signal)
    let companion
    if (result?.rig) {
      const changed = () => new Error('Staged Unreal package changed during reference skeleton decoding')
      for (const file of [input.header, result.sidecar].filter(Boolean)) {
        const expected = byOutput.get(relative(output, file.path).split(sep).join('/'))
        if (!expected) throw changed()
        const { hash, size } = await readVerifiedFile(output, file, { changed, signal })
        if (hash !== expected.hash || size !== expected.size) throw changed()
        if (file === result.sidecar) companion = expected
      }
    }
    await publish(input.asset, result, companion)
  }

  function finish() {
    for (const { asset, rig } of published.values()) {
      const path = rig.skeletonPackage
      if (!path) continue
      const target = resolve(path, asset)
      const object = published.get(target?.id)
      const resolved = object?.role === 'skeleton' && objectKey(object.rig.object) === objectKey(posix.basename(path))
      records.dependencies.push({ source: asset.id, target: target?.id ?? null, path,
        status: resolved ? 'resolved' : target ? 'unavailable' : 'missing', type: skeletonDependency })
      if (resolved) summary.linked++
    }
    return summary.skeletons || summary.meshReferencePoses || summary.incomplete || summary.issue ? summary : undefined
  }
  const reference = asset => published.get(asset.id)?.rig
  return { publish, publishCooked, finish, reference }
}
