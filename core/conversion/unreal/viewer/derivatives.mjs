import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { analyzeAsset } from '../../../analysis/asset-analysis.mjs'
import { convertBatchModel } from '../../../engines/blender/batch.mjs'
import { modelArtifact } from '../../artifacts.mjs'

const destination = { fbx: 'Models', glb: 'Previews' }

async function checkDerivative(workspace, path, format, original, signal) {
  const file = await modelArtifact(workspace, path, format, signal)
  if (!file || format === 'fbx') return file
  const { metrics } = await analyzeAsset(workspace, { absolute: file.path, path, info: file.info, ext: format }, signal)
  return metrics.bones >= original.metrics.bones && metrics.animations >= original.metrics.animations ? file : null
}

export async function createViewerDerivatives({ models, store, blender, output, workspace, formats, signal, onProgress }) {
  const counts = { fbx: 0, glb: 0 }
  const deadline = Date.now() + 5 * 60_000
  for (const [index, { asset, artifact }] of models.entries()) {
    signal?.throwIfAborted()
    onProgress?.(Math.floor(100 * index / models.length))
    const requested = formats.filter(format => !asset.exports.some(item => item.path && item.format === format &&
      item.method === 'unreal-editor' && item.role === artifact.role && artifact.lod === 0))
    if (!requested.length) continue
    const describe = format => ({ format, role: artifact.role, lod: artifact.lod, method: 'blender', from: artifact.path })
    const issue = !blender ? 'blender-unavailable' : Date.now() >= deadline ? 'converter-time-budget' :
      await store.preflight(512 * 1024 ** 2)
    if (issue) {
      for (const format of requested) asset.exports.push({ ...describe(format), issue,
        status: blender ? 'failed' : 'requires-tool' })
      continue
    }
    const scratch = await mkdtemp(join(workspace, 'viewer-model-'))
    try {
      const result = await convertBatchModel(blender, {
        source: join(output, artifact.path), root: output, workspace: scratch, formats: requested, signal,
      })
      const intact = result.metrics?.bones >= artifact.metrics.bones && result.metrics?.animations >= artifact.metrics.animations
      for (const format of requested) {
        const description = describe(format)
        const path = 'model.' + format
        const failure = result.error ?? result.outputs?.[format]
        const file = intact && failure === 'written' && await checkDerivative(scratch, path, format, artifact, signal)
        if (!file) {
          asset.exports.push({ ...description, status: 'failed', issue: failure === 'written' ?
            'invalid-converter-output' : failure ?? 'invalid-converter-output' })
          continue
        }
        const target = [destination[format], asset.id, 'ue-viewer', basename(artifact.path, '.gltf') + '.' + format].join('/')
        const saved = await store.save(target, file, { ...description, status: 'converted', converterVersion: result.version,
          sourceScene: result.metrics, issues: [...artifact.issues, ...(result.issues ?? [])] })
        asset.exports.push(saved)
        if (saved.path) counts[format]++
      }
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 })
    }
  }
  return counts
}
