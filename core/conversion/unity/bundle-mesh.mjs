import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { convertBatchModel } from '../../engines/blender/batch.mjs'
import { modelArtifact } from '../artifacts.mjs'
import { bundleIdentity } from './bundle-names.mjs'

async function exportFbx(source, relative, stage, store, options, signal) {
  const format = 'fbx'
  if (!options.blender) return { format, status: 'requires-tool', issue: 'blender-unavailable' }
  if (options.deadline.aborted) return { format, status: 'failed', issue: 'batch-time-limit' }
  const space = await store.preflight(512 * 1024 ** 2)
  if (space) return { format, status: 'failed', issue: space }
  const workspace = await mkdtemp(join(stage, 'fbx-'))
  try {
    let conversion
    try {
      conversion = await convertBatchModel(options.blender, {
        source: join(store.root, source), root: store.root, workspace, formats: [format], signal: options.signal,
      })
    } catch (error) {
      signal?.throwIfAborted()
      if (!options.deadline.aborted) throw error
      return { format, status: 'failed', issue: 'batch-time-limit' }
    }
    const result = conversion.error ?? conversion.outputs?.fbx
    const file = result === 'written' && await modelArtifact(workspace, 'model.fbx', format, signal)
    if (!file) return { format, status: 'failed', issue: !result || result === 'written' ? 'invalid-converter-output' : result }
    return await store.save(relative, file, { format, status: 'converted', method: 'blender', converterVersion: conversion.version })
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 })
  }
}

export async function saveBundleMesh(asset, stage, store, { method, converterVersion }, fbx, signal) {
  const { file: staged, size, ...entry } = asset
  const file = await modelArtifact(stage, staged, 'glb', signal)
  if (!file || file.info.size !== size) return { ...entry, status: 'failed', issue: 'unity-bundle-mesh-output' }
  const { id, label } = bundleIdentity(entry)
  const filename = label ? 'Mesh-' + label : 'Mesh'
  const artifact = await store.save('Previews/' + id + '/' + filename + '.glb', file, {
    status: 'converted', format: 'glb', method: method + '-static-mesh', converterVersion,
  })
  const outputs = fbx && artifact.status === 'converted' &&
    [await exportFbx(artifact.path, 'Models/' + id + '/' + filename + '.fbx', stage, store, fbx, signal)]
  return { ...entry, id, status: artifact.status, artifact, ...(outputs && { exports: outputs }) }
}
