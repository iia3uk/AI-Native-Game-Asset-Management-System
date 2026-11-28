import { mkdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { unrealGameAssetResolver } from '../../../engines/unreal/editor-package/game-path.mjs'
import { staticMeshPackage, supportsSourceMeshVersion } from '../../../engines/unreal/source-mesh/package.mjs'
import { decodeSourceMesh, sourceMeshFileLimit, sourceMeshRevision } from '../../../engines/unreal/source-mesh/run.mjs'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { ExportArtifacts } from '../../artifacts.mjs'
import { publishSourceCollision } from '../collision/publish.mjs'
import { publishUnrealGeometry } from '../mesh-artifact.mjs'

const method = 'unreal-source-mesh'

async function publishModel({ asset, scratch, store, lod, document, buffer, stem, signal, rawMesh }) {
  const identity = { status: 'converted', converterVersion: sourceMeshRevision, method, from: asset.output, lod,
    ...(rawMesh && { sourceFormat: 'FRawMesh' }) }
  const issues = ['unreal-source-mesh-material-graphs-not-extracted']
  if (rawMesh) issues.push('unreal-source-mesh-editor-build-not-applied')
  return publishUnrealGeometry({ asset, scratch, store, stem, document, buffer, folder: 'unreal-source', identity, issues, signal })
}

export async function publishSourceMeshes({ records, output, workspace, source, signal, store = new ExportArtifacts(output, signal) }) {
  const scratch = join(workspace, 'unreal-source-mesh')
  await mkdir(scratch)
  const resolveMaterial = unrealGameAssetResolver(records.assets, source.root)
  const models = []
  const summary = { converterVersion: sourceMeshRevision, meshes: 0, gltf: 0, failed: 0, missingLods: 0, texturedGltf: 0 }
  const collision = summary.collision = { assets: 0, shapes: 0, glb: 0, incomplete: 0 }
  const deadline = Date.now() + 90_000
  for (const asset of records.assets) {
    signal?.throwIfAborted()
    if (!asset.output || asset.issue || asset.type !== 'uasset' || asset.storage !== 'editor' ||
        asset.layout !== -7 || !supportsSourceMeshVersion(asset.ue4) || asset.ue5 !== 0 || asset.size > sourceMeshFileLimit) continue
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
      if (!staticMeshPackage(prefix, asset.ue4)) continue
    } catch (error) {
      if (error instanceof RangeError) continue
      throw error
    }
    const stem = posix.basename(asset.sourcePath).slice(0, -7).replace(/[#%]/g, '_')
    const render = !asset.exports.some(item => item.path && item.role === 'model' && item.format === 'gltf' && item.lod === 0)
    const result = await decodeSourceMesh(prefix, stem, { signal, render, version: asset.ue4,
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
        const material = resolveMaterial(path, asset)
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
