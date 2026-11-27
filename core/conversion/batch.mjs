import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { convertBatchModel } from '../engines/blender/batch.mjs'
import { fileInfo } from '../files/asset-files.mjs'
import { packageExportVersion } from './formats.mjs'
import { artifactPath, exportFolders, ExportArtifacts, modelArtifact } from './artifacts.mjs'
import { publishUnityArtifacts } from './unity-artifacts.mjs'

const convertible = new Set(['fbx', 'glb', 'gltf', 'obj'])
const packageConversionBudget = 480_000
const limitations = ['unity-objects-not-decoded', 'material-graphs-not-converted', 'no-engine-lod-or-collision-semantics',
  'model-conversion-can-change-shader-and-animation-representation']

export async function exportPackage({ output, scratch, entries, formats, blender, bridge, signal, onProgress }) {
  const source = join(output, 'Source')
  const store = new ExportArtifacts(output, signal)
  const deadline = AbortSignal.timeout(packageConversionBudget)
  const batchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  await Promise.all(exportFolders.map(directory => mkdir(join(output, directory), { recursive: true })))
  const counts = Object.create(null)
  let modelsConverted = 0
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted()
    entry.exports = []
    if (entry.output) {
      if (entry.kind === 'model') {
        const artifacts = await exportModel({ entry, formats, source, scratch, store, blender, signal, batchSignal, deadline })
        entry.exports.push(...artifacts)
      } else if (artifactPath(entry, 'original')) {
        const file = await fileInfo(output, entry.output)
        entry.exports.push(await store.save(artifactPath(entry, 'original'), file, {
          method: 'original-copy', format: extname(entry.output).slice(1).toLowerCase(), status: 'extracted', sha256: entry.hash,
        }))
      }
    }
    if (bridge) {
      entry.exports.push(...await publishUnityArtifacts(entry, bridge, {
        store, formats, blender, scratch, signal, batchSignal, deadline,
      }))
    }
    const converted = entry.exports.filter(artifact => artifact.status === 'converted')
    if (converted.length && !entry.issues.includes('missing-dependencies')) entry.status = 'converted'
    if (converted.some(artifact => ['fbx', 'glb'].includes(artifact.format) && artifact.role !== 'animation')) {
      modelsConverted++
    }
    if (entry.metadata) {
      const file = await fileInfo(output, entry.metadata)
      entry.exports.push(await store.save(artifactPath(entry, 'meta'), file, {
        method: 'original-copy', format: 'meta', status: 'extracted', sha256: entry.metadataHash,
      }))
    }
    for (const { status } of entry.exports) counts[status] = (counts[status] ?? 0) + 1
    onProgress?.(76 + Math.floor(18 * (index + 1) / entries.length))
  }
  return { version: packageExportVersion, formats, counts, modelsConverted, ...(bridge && { unity: bridge.summary }),
    limitations: bridge ? limitations.slice(1) : limitations }
}

async function exportModel({ entry, formats, source, scratch, store, blender, signal, batchSignal, deadline }) {
  const ext = extname(entry.sourcePath).slice(1).toLowerCase()
  const pending = new Set(formats)
  const results = []
  if (pending.has(ext)) {
    const original = await modelArtifact(source, entry.sourcePath, ext, signal)
    if (original) {
      results.push(await store.save(artifactPath(entry, ext), original, {
        method: 'original-copy', format: ext, status: 'ready', sha256: entry.hash,
        ...(ext === 'fbx' && { issues: ['external-fbx-textures-may-need-relinking'] }),
      }))
      pending.delete(ext)
    }
  }
  if (!pending.size) return results
  const skip = !convertible.has(ext) ? ['unsupported', 'model-format-unsupported'] :
    !blender ? ['requires-tool', 'blender-unavailable'] :
      deadline.aborted ? ['failed', 'batch-time-limit'] : null
  if (skip) return results.concat([...pending].map(format => ({ format, status: skip[0], issue: skip[1] })))
  const space = await store.preflight(512 * 1024 ** 2)
  if (space) return results.concat([...pending].map(format => ({ format, status: 'failed', issue: space })))
  const workspace = await mkdtemp(join(scratch, 'model-'))
  try {
    let conversion
    try {
      conversion = await convertBatchModel(blender, {
        source: join(source, entry.sourcePath), root: source, workspace, formats: [...pending], signal: batchSignal,
      })
    } catch (error) {
      signal?.throwIfAborted()
      if (!deadline.aborted) throw error
      conversion = { error: 'batch-time-limit' }
    }
    for (const format of pending) {
      const issue = conversion.error ?? conversion.outputs?.[format]
      const file = issue === 'written' ? await modelArtifact(workspace, 'model.' + format, format, signal) : null
      if (!file) {
        results.push({ format, status: issue === 'missing-model-dependency' ? 'missing-dependencies' : 'failed',
          issue: issue && issue !== 'written' ? issue : 'invalid-converter-output' })
        continue
      }
      results.push(await store.save(artifactPath(entry, format), file, {
        format, status: 'converted', method: 'blender', converterVersion: conversion.version,
        sourceScene: conversion.metrics, issues: conversion.issues,
      }))
    }
    return results
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }
}
