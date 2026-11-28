import { opendir } from 'node:fs/promises'
import { posix } from 'node:path'
import { checkedPath } from '../../../files/asset-files.mjs'
import { validPackageSegment } from '../../../packages/source.mjs'
import { viewerAnimation } from './animation.mjs'
import { viewerModel } from './model.mjs'

const pathKey = path => path.normalize('NFC').toLowerCase()

export async function publishViewerOutputs({ targets, decoded, viewer, store, signal }) {
  const bySource = new Map(targets.map(asset => [pathKey(asset.sourcePath), asset]))
  const directories = new Set(targets.map(asset => posix.dirname(asset.sourcePath)))
  const counts = { gltf: 0, psa: 0, invalid: 0 }
  const models = []
  for (const folder of directories) {
    const path = await checkedPath(decoded, folder)
    if (!path) continue
    let files = 0
    for await (const entry of await opendir(path)) {
      signal?.throwIfAborted()
      if (++files > 30_000) break
      const { name } = entry
      if (!entry.isFile() || !validPackageSegment(name)) continue
      const match = /^(.+)\.(gltf|psa)$/.exec(name)
      if (!match) continue
      const [, stem, format] = match
      const locate = name => bySource.get(pathKey(posix.join(folder, name + '.uasset')))
      const lod = /_Lod([1-9]\d?)$/.exec(stem)
      const direct = locate(stem)
      const asset = direct ?? (lod && format === 'gltf' && locate(stem.slice(0, -lod[0].length)))
      if (!asset) continue
      const lodIndex = !direct && lod ? Number(lod[1]) : 0
      const key = posix.join(folder, name)
      const identity = { status: 'converted', converterVersion: viewer.version, method: 'ue-viewer', from: asset.output }
      if (format === 'psa') {
        const animation = await viewerAnimation(decoded, key, signal)
        if (!animation) {
          counts.invalid++
          asset.issues.push('unreal-viewer-invalid-animation')
          continue
        }
        const artifact = await store.save('Animations/' + asset.id + '/' + name, animation.file,
          { ...identity, format, role: 'animation', metrics: animation.metadata, issues: ['actorx-animation-requires-compatible-skeleton'] })
        asset.exports.push(artifact)
        if (artifact.path) counts.psa++
      } else {
        const model = await viewerModel(decoded, key, signal)
        if (!model) {
          counts.invalid++
          asset.issues.push('unreal-viewer-invalid-model')
          continue
        }
        const role = model.metrics.bones > 0 ? 'skeletal-model' : 'model'
        const issue = await store.preflight(model.file.info.size + model.buffer.info.size)
        if (issue) {
          asset.exports.push({ ...identity, status: 'failed', issue, role, format })
          continue
        }
        const target = 'Models/' + asset.id + '/ue-viewer/'
        const buffer = await store.save(target + model.bin, model.buffer, { ...identity, format: 'bin', role: 'model-buffer' })
        if (!buffer.path) {
          asset.exports.push(buffer)
          continue
        }
        const artifact = await store.save(target + name, model.file, { ...identity, format, role, lod: lodIndex,
          metrics: model.metrics, issues: ['unreal-viewer-original-gltf-has-no-material-maps'] })
        asset.exports.push(buffer, artifact)
        if (artifact.path) {
          models.push({ asset, artifact })
          counts.gltf++
        }
      }
      if (asset.exports.some(item => item.path && item.format !== 'bin')) asset.status = 'converted'
    }
  }
  return { counts, models }
}
