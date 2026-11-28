import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import { staticMeshPackage } from '../../../engines/unreal/source-mesh/package.mjs'
import { decodeSourceMesh, sourceMeshFileLimit, sourceMeshRevision } from '../../../engines/unreal/source-mesh/run.mjs'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { ExportArtifacts } from '../../artifacts.mjs'
import { publishSourceCollision } from '../collision/publish.mjs'
import { viewerModel } from '../viewer/model.mjs'

const method = 'unreal-source-mesh'
const key = path => path.normalize('NFC').toLowerCase()

export function sourceMaterialResolver(assets, root) {
  const byPath = new Map(assets.filter(asset => asset.output && asset.type === 'uasset')
    .map(asset => [key(asset.sourcePath), asset]))
  const selected = key(root.replaceAll('\\', '/').replace(/\/$/, ''))
  return path => {
    if (typeof path !== 'string' || !path.startsWith('/Game/')) return null
    const parts = path.slice(6).split('/')
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return null
    if (parts.length === 1 && basename(root).toLowerCase() !== 'content') return null
    for (let skip = 0; skip < parts.length; skip++) {
      if (skip && !selected.endsWith('/' + key(parts.slice(0, skip).join('/')))) continue
      const asset = byPath.get(key(parts.slice(skip).join('/') + '.uasset'))
      if (asset) return asset
    }
    return null
  }
}

async function publishModel({ asset, scratch, store, lod, document, buffer, stem, signal }) {
  const bin = stem + '.bin'
  const name = stem + '.gltf'
  const target = 'Models/' + asset.id + '/unreal-source/'
  const json = JSON.stringify(document)
  const identity = { status: 'converted', converterVersion: sourceMeshRevision, method, from: asset.output, lod }
  const issue = await store.preflight(Buffer.byteLength(json) + buffer.byteLength)
  if (issue) return { issue }
  await Promise.all([writeFile(join(scratch, name), json, { signal }), writeFile(join(scratch, bin), buffer, { signal })])
  const model = await viewerModel(scratch, name, signal)
  if (!model) return { issue: 'unreal-source-mesh-invalid-model' }
  const savedBuffer = await store.save(target + bin, model.buffer, { ...identity, format: 'bin', role: 'model-buffer' })
  if (!savedBuffer.path) return { issue: savedBuffer.issue }
  const artifact = await store.save(target + name, model.file, { ...identity, format: 'gltf', role: 'model',
    metrics: model.metrics, issues: ['unreal-source-mesh-material-graphs-not-extracted'] })
  asset.exports.push(savedBuffer, artifact)
  return { artifact }
}

export async function publishSourceMeshes({ records, output, workspace, source, signal, store = new ExportArtifacts(output, signal) }) {
  const scratch = join(workspace, 'unreal-source-mesh')
  await mkdir(scratch)
  const resolveMaterial = sourceMaterialResolver(records.assets, source.root)
  const models = []
  const summary = { converterVersion: sourceMeshRevision, meshes: 0, gltf: 0, failed: 0, missingLods: 0, texturedGltf: 0 }
  const collision = summary.collision = { assets: 0, shapes: 0, glb: 0, incomplete: 0 }
  const deadline = Date.now() + 90_000
  for (const asset of records.assets) {
    signal?.throwIfAborted()
    if (!asset.output || asset.issue || asset.type !== 'uasset' || asset.storage !== 'editor' ||
        asset.layout !== -7 || asset.ue4 !== 522 || asset.ue5 !== 0 || asset.size > sourceMeshFileLimit) continue
    if (Date.now() >= deadline) {
      summary.issue = 'unreal-source-mesh-time-budget'
      break
    }
    const file = await fileInfo(output, asset.output)
    const changed = () => new Error('Staged Unreal package changed during source mesh decoding')
    if (!file || file.info.size !== asset.size) throw changed()
    const { prefix, hash } = await readVerifiedFile(output, file, { capture: asset.size, changed, signal })
    if (hash !== asset.hash) throw changed()
    try {
      if (!staticMeshPackage(prefix)) continue
    } catch (error) {
      if (error instanceof RangeError) continue
      throw error
    }
    const stem = posix.basename(asset.sourcePath).slice(0, -7).replace(/[#%]/g, '_')
    const render = !asset.exports.some(item => item.path && item.role === 'model' && item.format === 'gltf' && item.lod === 0)
    const result = await decodeSourceMesh(prefix, stem, { signal, render,
      timeout: Math.min(12_000, Math.max(1, deadline - Date.now())) })
    if (!result) continue
    if (result.issue) {
      summary.failed++
      asset.issues.push(result.issue)
      if (result.issue !== 'unreal-source-mesh-layout') summary.issue ??= result.issue
    }
    if (result.missing?.length) {
      summary.missingLods += result.missing.length
      asset.issues.push('unreal-source-mesh-lods-need-build')
    }
    let collisionIssue = result.collisionIssue
    if (result.collision) {
      const saved = await publishSourceCollision({ asset, collision: result.collision, scratch, stem, store, signal })
      if (saved.description) {
        collision.assets++
        collision.shapes += result.collision.shapes.length
      }
      if (saved.preview?.path) collision.glb++
      collisionIssue ??= saved.issue ?? ((result.collision.omitted.length || result.collision.previewOmitted?.length)
        ? 'unreal-source-collision-partial' : null)
    }
    if (collisionIssue) {
      collision.incomplete++
      asset.collisionIssue = collisionIssue
      asset.issues.push(collisionIssue)
    }
    let published = false
    for (const mesh of result.meshes ?? []) {
      const { lod, materialPaths } = mesh
      const { artifact, issue } = await publishModel({ ...mesh, asset, scratch, store, signal,
        stem: stem + (lod ? '_Lod' + lod : '') })
      if (!artifact?.path) {
        asset.issues.push(issue ?? artifact.issue)
        summary.failed++
        continue
      }
      published = true
      models.push({ asset, artifact })
      summary.gltf++
      for (const path of materialPaths) {
        const material = resolveMaterial(path)
        records.dependencies.push({ source: asset.id, target: material?.id ?? null, path: material?.sourcePath ?? path,
          type: 'unreal-model-material', status: material ? 'resolved' : 'missing', lod })
      }
    }
    if (published) {
      asset.status = 'converted'
      summary.meshes++
    }
  }
  return { models, store, summary, resolveMaterial }
}
