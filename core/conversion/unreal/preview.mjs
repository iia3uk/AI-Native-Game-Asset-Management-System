import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { modelArtifact } from '../artifacts.mjs'
import { convertBatchModel } from '../../engines/blender/batch.mjs'

const modelRoles = new Set(['model', 'skeletal-model', 'animation'])

export async function unrealPreview(artifact, { blender, output, scratch, id, store, signal }) {
  if (artifact.format !== 'fbx' || artifact.status !== 'converted' || !modelRoles.has(artifact.role)) return null
  const description = { format: 'glb', role: artifact.role, method: 'blender', from: artifact.path }
  if (!blender) return { ...description, status: 'requires-tool', issue: 'blender-unavailable' }
  const space = await store.preflight(512 * 1024 ** 2)
  if (space) return { ...description, status: 'failed', issue: space }
  const workspace = await mkdtemp(join(scratch, 'preview-'))
  try {
    const result = await convertBatchModel(blender, {
      source: join(output, artifact.path), root: output, workspace, formats: ['glb'], signal,
    })
    const issue = result.error ?? result.outputs?.glb
    const file = issue === 'written' && await modelArtifact(workspace, 'model.glb', 'glb', signal)
    if (!file) return { ...description, status: 'failed', issue: issue && issue !== 'written' ? issue : 'invalid-converter-output' }
    const path = ['Previews', id, basename(artifact.path, '.fbx') + '.glb'].join('/')
    return store.save(path, file, { ...description, status: 'converted', converterVersion: result.version,
      sourceScene: result.metrics, issues: result.issues })
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 })
  }
}
