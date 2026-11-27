import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { convertBatchModel } from '../engines/blender/batch.mjs'
import { fileInfo, readBoundedText } from '../files/asset-files.mjs'
import { analyzeAsset } from '../analysis/asset-analysis.mjs'
import { modelArtifact } from './artifacts.mjs'

function relativePath(id, product, format) {
  const category = format === 'glb' ? 'Previews' : ({ animation: 'Animations', texture: 'Textures', material: 'Materials' })[product.role] ?? 'Models'
  return [category, id, product.role + '-' + product.number + '.' + format].join('/')
}

async function verifyProduct(root, path, product, signal) {
  if (product.format === 'fbx') return modelArtifact(root, path, 'fbx', signal)
  const file = await fileInfo(root, path)
  if (!file || file.info.size > 512 * 1024 ** 2) return null
  if (product.format === 'png') {
    const { metrics } = await analyzeAsset(root, { absolute: file.path, path, info: file.info, ext: 'png' }, signal)
    return metrics.width === product.width && metrics.height === product.height ? file : null
  }
  const text = await readBoundedText(root, path, 1024 ** 2)
  try { return Array.isArray(JSON.parse(text)?.textures) ? file : null } catch { return null }
}

export async function publishUnityArtifacts(entry, bridge, { store, formats, blender, scratch, signal, batchSignal, deadline }) {
  const result = bridge.results.get(entry.id)
  if (!result) return []
  const artifacts = []
  if (result.issue) entry.issues.push(result.issue)
  for (const product of result.products ?? []) {
    signal?.throwIfAborted()
    const details = {
      role: product.role, unityGUID: product.guid || null, unityFileID: product.fileID || null,
      name: product.name?.slice(0, 180) || null,
      method: 'unity-editor', editorVersion: bridge.summary.editorVersion, converterVersion: bridge.summary.exporterVersion,
      ...(product.role === 'component' && { nodePath: product.nodePath?.slice(0, 4096) ?? '' }),
      ...(product.role === 'animation' && { issues: ['unity-synthetic-animation-hierarchy'] }),
      ...(product.role === 'texture' && { width: product.width, height: product.height, colorSpace: product.colorSpace }),
    }
    const source = entry.id + '/' + product.number + '.' + product.format
    const artifact = !product.issue && await verifyProduct(bridge.outputRoot, source, product, signal)
    const fbx = product.format === 'fbx'
    if (fbx && formats.includes('glb') && product.role !== 'animation') {
      const identity = { ...details, format: 'glb', status: 'failed' }
      let issue = product.issue || 'unity-fbx-unavailable'
      if (artifact) {
        issue = !blender ? 'blender-unavailable' : deadline.aborted ? 'batch-time-limit' : null
        if (!issue) {
          artifacts.push(await previewUnityModel(artifact, entry, product, identity, bridge, {
            store, blender, scratch, signal, batchSignal, deadline,
          }))
        }
      }
      if (issue) artifacts.push({ ...identity, status: issue === 'blender-unavailable' ? 'requires-tool' : 'failed', issue })
    }
    if (!fbx || formats.includes('fbx')) {
      const identity = { ...details, format: product.format }
      artifacts.push(artifact
        ? await store.save(relativePath(entry.id, product, product.format), artifact, { ...identity, status: 'converted' })
        : { ...identity, status: 'failed', issue: product.issue || 'invalid-unity-artifact' })
    }
  }
  return artifacts
}

async function previewUnityModel(artifact, entry, product, details, bridge, { store, blender, scratch, signal, batchSignal, deadline }) {
  const temporary = await mkdtemp(join(scratch, 'unity-glb-'))
  try {
    let converted
    try {
      converted = await convertBatchModel(blender, {
        source: artifact.path, root: bridge.outputRoot, workspace: temporary, formats: ['glb'], signal: batchSignal,
      })
    } catch (error) {
      signal?.throwIfAborted()
      if (!deadline.aborted) throw error
      return { ...details, issue: 'batch-time-limit' }
    }
    const preview = converted.outputs?.glb === 'written' && await modelArtifact(temporary, 'model.glb', 'glb', signal)
    if (!preview) return { ...details, issue: converted.error || 'invalid-converter-output' }
    return await store.save(relativePath(entry.id, product, 'glb'), preview, {
      ...details, status: 'converted', method: 'unity-editor+blender', unityExporterVersion: details.converterVersion,
      converterVersion: converted.version, issues: converted.issues,
    })
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}
