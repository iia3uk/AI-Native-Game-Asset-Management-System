import { writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { unrealGameAssetResolver } from '../../../engines/unreal/editor-package/game-path.mjs'
import { editorAnimationRevision, readEditorAnimation } from '../../../engines/unreal/animation/ue4-514.mjs'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { encodeGlb } from '../../glb.mjs'
import { animationSkeletonDependency, declaredSkeleton, editorAnimationBindingMethod, editorAnimationMethod,
  editorClipPath, modelAnimationDependency, modelJointNodes } from './binding.mjs'
import { animatedSkeleton, appendEditorAnimations, encodeBoneTracks } from './gltf.mjs'

const limitations = ['unreal-editor-animation-bone-tracks-only']
const maxClips = 1024
const maxClipsPerModel = 256
const maxBytes = 64 * 1024 ** 2
const maxModelBytes = 16 * 1024 ** 2

async function publishClip({ clip, rig, asset, workspace, store, signal }) {
  const document = animatedSkeleton(rig)
  const { parts, size } = appendEditorAnimations(document, [clip], document.nodes.map((_, index) => index))
  document.buffers = [{ byteLength: size }]
  const bytes = encodeGlb(document, parts, size)
  const scratch = join(workspace, 'ue4-clip.glb')
  const issue = await store.preflight(bytes.length)
  if (issue) return { issue }
  await writeFile(scratch, bytes, { signal })
  return store.save(editorClipPath(asset), { path: scratch, info: { size: bytes.length } },
    { format: 'glb', role: 'animation', method: editorAnimationMethod, status: 'converted',
      converterVersion: editorAnimationRevision, from: asset.output, name: clip.name,
      frames: clip.frames, duration: clip.duration, bones: rig.bones.length, issues: limitations })
}

async function readModel(root, artifact, signal) {
  const file = artifact.size <= maxModelBytes && await fileInfo(root, artifact.path)
  if (!file || file.info.size !== artifact.size) return null
  const changed = () => new Error('Staged skeletal mesh changed before animation binding')
  const { hash, prefix } = await readVerifiedFile(root, file, { capture: file.info.size, signal, changed })
  if (hash !== artifact.sha256) throw changed()
  return JSON.parse(prefix)
}

async function publishModel({ artifact, input, document, entries, nodes, workspace, store, signal }) {
  const path = artifact.path.replace(/\.gltf$/, '-animated.gltf')
  const binary = path.replace(/\.gltf$/, '.bin')
  const usedNames = new Set()
  const clips = entries.map(({ asset, clip }) => {
    let name = clip.name
    if (usedNames.has(name)) name += ' · ' + asset.id
    usedNames.add(name)
    return { ...clip, name }
  })
  const { parts, size } = appendEditorAnimations(document, clips, nodes)
  document.buffers.push({ uri: posix.basename(binary), byteLength: size })
  const json = Buffer.from(JSON.stringify(document))
  const issue = json.length > maxModelBytes ? 'unreal-animation-model-size-limit' : await store.preflight(json.length + size)
  if (issue) return { issue }
  const scratch = join(workspace, 'ue4-animated.bin')
  const model = join(workspace, 'ue4-animated.gltf')
  await writeFile(scratch, parts, { signal })
  await writeFile(model, json, { signal })
  const details = { status: 'converted', method: editorAnimationBindingMethod, converterVersion: editorAnimationRevision,
    from: input.path, sourceModel: artifact.path }
  const bin = await store.save(binary, { path: scratch, info: { size } }, { ...details, format: 'bin', role: 'animation-buffer' })
  if (!bin.path) return { issue: bin.issue }
  const saved = await store.save(path, { path: model, info: { size: json.length } },
    { ...details, format: 'gltf', role: artifact.role, lod: 0,
      metrics: { ...artifact.metrics, animations: clips.length }, issues: [...input.issues, ...limitations] })
  if (!saved.path) return { issue: saved.issue, bin }
  return { saved, bin }
}

export function createEditorAnimationPublisher({ records, output, workspace, source, signal, skeletons }) {
  const clips = []
  const resolve = unrealGameAssetResolver(records.assets, source.root)
  const summary = { clips: 0, models: 0, bindings: 0, incomplete: 0 }
  let readBytes = 0
  function capture(asset, bytes, table) {
    const result = readEditorAnimation(bytes, table, signal)
    if (!result) return
    if (result.issue) {
      asset.issues.push(result.issue)
      summary.incomplete++
      return
    }
    const { clip } = result
    if (clips.length >= maxClips || readBytes + clip.size > maxBytes) {
      asset.issues.push('unreal-editor-animation-limit')
      summary.incomplete++
      return
    }
    clips.push({ asset, clip })
    readBytes += clip.size
  }

  async function publish({ models, store }) {
    const byRig = new Map()
    for (const { clip, asset } of clips) {
      signal?.throwIfAborted()
      const { rig, target } = declaredSkeleton(resolve, skeletons, clip.skeletonPackage, asset)
      const idMatches = rig?.skeletonGuid === clip.skeletonGuid && /[1-9a-f]/.test(clip.skeletonGuid)
      const tracks = idMatches && encodeBoneTracks(clip, rig)
      if (clip.skeletonPackage) records.dependencies.push({ source: asset.id, target: target?.id ?? null,
        path: clip.skeletonPackage, type: animationSkeletonDependency,
        status: tracks ? 'resolved' : target ? 'unavailable' : 'missing' })
      const artifact = tracks ? await publishClip({ clip: tracks, rig, asset, workspace, store, signal }) :
        { issue: target ? 'unreal-editor-animation-skeleton-mismatch' : 'unreal-editor-animation-skeleton-missing' }
      if (!artifact.path) {
        asset.issues.push(artifact.issue)
        summary.incomplete++
        continue
      }
      asset.exports.push(artifact)
      asset.status = 'converted'
      summary.clips++
      const group = byRig.get(target.id) ?? []
      group.push({ asset, clip: tracks })
      byRig.set(target.id, group)
    }
    for (const { asset, artifact } of models) {
      signal?.throwIfAborted()
      if (artifact.role !== 'skeletal-model') continue
      const mesh = skeletons.reference(asset)
      const { rig, target } = declaredSkeleton(resolve, skeletons, mesh?.skeletonPackage, asset)
      const all = target && byRig.get(target.id)
      if (!all) continue
      const entries = all.slice(0, maxClipsPerModel)
      if (entries.length < all.length) asset.issues.push('unreal-editor-animation-limit')
      const input = asset.exports.find(item => item.path && item.method === 'unreal-source-mesh-material-binding' &&
        item.from === artifact.path) ?? artifact
      const document = await readModel(output, input, signal)
      const nodes = document && modelJointNodes(document, mesh, rig)
      if (!nodes) {
        asset.issues.push('unreal-editor-animation-skeleton-mismatch')
        continue
      }
      const { issue, bin, saved } = await publishModel({ artifact, input, document, entries, nodes, workspace, store, signal })
      if (bin) asset.exports.push(bin)
      if (issue) {
        asset.issues.push(issue)
        if (bin) summary.issue = issue
        continue
      }
      asset.exports.push(saved)
      summary.models++
      summary.bindings += entries.length
      for (const entry of entries) records.dependencies.push({ source: asset.id, target: entry.asset.id,
        path: entry.asset.sourcePath, type: modelAnimationDependency, status: 'resolved' })
    }
    return summary.clips || summary.incomplete ? summary : undefined
  }
  return { capture, publish }
}
