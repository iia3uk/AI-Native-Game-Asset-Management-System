import { basename, join } from 'node:path'
import { open, writeFile } from 'node:fs/promises'
import { fileInfo, readBoundedText } from '../../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../../files/read-verified.mjs'
import { actorXClips, actorXSettings, maxClipBytes, maxSettingsBytes } from './clips.mjs'
import { actorXBinding, actorXBoneKey, viewerSkeleton } from './skeleton.mjs'
import { actorXTracks, appendActorXAnimations } from './tracks.mjs'

const maxAnimationBytes = 64 * 1024 ** 2
const maxModelBytes = 16 * 1024 ** 2
const maxClipsPerRig = 256
export const animationBindingMethod = 'ue-viewer-animation-binding'

async function verifiedBytes(root, artifact, limit, signal) {
  if (!artifact.path || artifact.size > limit) return null
  const file = await fileInfo(root, artifact.path)
  if (!file || file.info.size !== artifact.size) return null
  const read = await readVerifiedFile(root, file, { capture: limit, signal,
    changed: () => new Error('ActorX output changed before binding') })
  return read.hash === artifact.sha256 ? read.prefix : null
}

async function modelDocument(output, path) {
  const text = await readBoundedText(output, path, maxModelBytes)
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

async function readRigs(models, output, signal) {
  const rigs = new Map()
  for (const { asset, artifact } of models) {
    signal?.throwIfAborted()
    if (artifact.role !== 'skeletal-model' || artifact.lod !== 0) continue
    const document = await modelDocument(output, artifact.path)
    const skeleton = viewerSkeleton(document)
    if (!skeleton || document.animations?.length) continue
    const input = asset.exports.find(item => item.path && item.method === 'ue-viewer-material-binding' &&
      item.from === artifact.path) ?? artifact
    const rig = { asset, artifact, input, skeleton, clips: new Map(), sources: new Set() }
    const group = rigs.get(skeleton.key)
    if (group) group.push(rig)
    else rigs.set(skeleton.key, [rig])
  }
  return rigs
}

async function readAnimation(output, entry, signal) {
  const data = await verifiedBytes(output, entry.artifact, maxClipBytes, signal)
  const psa = data && actorXClips(data)
  if (!psa) return null
  const config = entry.artifact.settingsPath ? entry.settings &&
    await verifiedBytes(output, entry.settings, maxSettingsBytes, signal) : Buffer.alloc(0)
  const settings = config && actorXSettings(config.toString('utf8'), psa)
  return settings ? { psa, settings } : null
}

async function publishRig(rig, { output, workspace, store, signal }) {
  const { artifact, input, clips } = rig
  const document = await modelDocument(output, input.path)
  if (!document) return false
  const path = artifact.path.replace(/\.gltf$/, '-animated.gltf')
  const binary = path.replace(/\.gltf$/, '.bin')
  const data = appendActorXAnimations(document, [...clips.values()], basename(binary))
  const json = JSON.stringify(document)
  const size = Buffer.byteLength(json)
  const bytes = document.buffers.at(-1).byteLength
  const issue = size > maxModelBytes ? 'unreal-animation-model-size-limit' : await store.preflight(size + bytes)
  if (issue) {
    rig.asset.issues.push(issue)
    return false
  }
  const scratch = join(workspace, 'actorx-animation.bin')
  const file = await open(scratch, 'w')
  try {
    for (const block of data) {
      signal?.throwIfAborted()
      await file.writeFile(block, { signal })
    }
  } finally { await file.close() }
  const description = { status: 'converted', converterVersion: artifact.converterVersion, method: animationBindingMethod,
    from: input.path, sourceModel: artifact.path }
  const buffer = await store.save(binary, { path: scratch, info: { size: bytes } },
    { ...description, format: 'bin', role: 'animation-buffer' })
  rig.asset.exports.push(buffer)
  if (!buffer.path) return false
  const temp = join(workspace, 'actorx-animation.gltf')
  await writeFile(temp, json, { signal })
  const saved = await store.save(path, { path: temp, info: { size } }, { ...description,
    format: 'gltf', role: artifact.role, lod: 0, metrics: { ...artifact.metrics, animations: clips.size },
    issues: [...input.issues, 'actorx-sampled-bone-tracks-only'] })
  rig.asset.exports.push(saved)
  return Boolean(saved.path)
}

export async function publishActorXAnimations({ models, animations, output, workspace, store, records, signal }) {
  const summary = { models: 0, clips: 0, unbound: animations.length }
  if (!animations.length) return summary
  const rigs = await readRigs(models, output, signal)
  const used = new Set()
  let usedBytes = 0
  for (const entry of animations) {
    signal?.throwIfAborted()
    const animation = await readAnimation(output, entry, signal)
    if (!animation) {
      entry.asset.issues.push('unreal-actorx-unsupported-tracks')
      continue
    }
    const { psa, settings } = animation
    const candidates = []
    for (const rig of rigs.get(actorXBoneKey(psa)) ?? []) {
      const binding = actorXBinding(psa, rig.skeleton)
      if (binding) candidates.push({ rig, binding })
      if (candidates.length > 1) break
    }
    if (candidates.length !== 1) {
      entry.asset.issues.push(candidates.length ? 'unreal-actorx-ambiguous-skeleton' : 'unreal-actorx-no-compatible-skeleton')
      continue
    }
    const [{ rig, binding }] = candidates
    let accepted = 0
    for (const clip of psa.clips.values()) {
      const bytes = clip.count * (psa.bones.size * 28 + 4)
      if (usedBytes + bytes > maxAnimationBytes || rig.clips.size >= maxClipsPerRig) {
        entry.asset.issues.push('unreal-actorx-animation-limit')
        break
      }
      if (rig.clips.has(clip.name)) {
        entry.asset.issues.push('unreal-actorx-duplicate-clip')
        continue
      }
      const encoded = actorXTracks(psa, clip, binding, settings, signal)
      if (!encoded) {
        entry.asset.issues.push('unreal-actorx-unsupported-tracks')
        continue
      }
      rig.clips.set(clip.name, encoded)
      usedBytes += bytes
      accepted++
    }
    if (accepted) {
      used.add(rig)
      rig.sources.add(entry)
    }
  }
  for (const rig of used) {
    if (!await publishRig(rig, { output, workspace, store, signal })) continue
    summary.models++
    summary.clips += rig.clips.size
    summary.unbound -= rig.sources.size
    for (const { asset } of rig.sources) records.dependencies.push({ source: asset.id, target: rig.asset.id,
      path: rig.asset.sourcePath, type: 'unreal-actorx-skeleton', status: 'resolved' })
  }
  return summary
}
