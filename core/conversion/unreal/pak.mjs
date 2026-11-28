import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { analyzeAsset } from '../../analysis/asset-analysis.mjs'
import { fileInfo } from '../../files/asset-files.mjs'
import { inspectUnrealFile } from '../../packages/unreal/inspect.mjs'
import { isWaveArtifact, modelArtifact } from '../artifacts.mjs'

const categories = { png: 'Textures', wav: 'Audio', fbx: 'Models', glb: 'Previews' }
const companions = new Set(['uexp', 'ubulk', 'uptnl'])

async function pngMetrics(root, file, name, signal) {
  const { metrics } = await analyzeAsset(root, { absolute: file.path, path: name, info: file.info, ext: 'png' }, signal)
  return metrics
}

async function validatedArtifact(root, entry, signal) {
  const file = await fileInfo(root, entry.file)
  if (!file || file.info.size !== entry.size) return null
  if (entry.format === 'fbx' || entry.format === 'glb') {
    return modelArtifact(root, entry.file, entry.format, signal)
  }
  if (entry.format === 'png') {
    const metrics = await pngMetrics(root, file, entry.path, signal)
    return metrics.width > 0 && metrics.height > 0 ? file : null
  }
  if (entry.format === 'wav') return await isWaveArtifact(file) ? file : null
  if (companions.has(entry.format)) return file
  const info = await inspectUnrealFile(root, { file, name: entry.path, type: entry.format }, signal)
  return ['editor', 'cooked', 'unversioned'].includes(info.storage) ? file : null
}

async function publishTexture(root, store, { texture, textureIssue }, artifact, id, path, converterVersion, signal) {
  const details = { role: 'texture', format: 'png', method: 'cue4parse-cooked-texture', converterVersion,
    from: artifact.path }
  if (textureIssue) return { ...details, status: 'skipped', issue: textureIssue }
  const { file: input, size, ...image } = texture
  const file = await fileInfo(root, input)
  const destination = 'Textures/' + id + '/' + posix.basename(path).slice(0, -7) + '.png'
  if (file?.info.size === size) {
    const metrics = await pngMetrics(root, file, destination, signal)
    if (metrics.width === image.width && metrics.height === image.height) {
      return store.save(destination, file, { ...details, ...image, status: 'converted' })
    }
  }
  return { ...details, status: 'failed', issue: 'unreal-cooked-texture-output' }
}

export async function publishPakEntries(entries, root, store, backendVersion, signal) {
  const accepted = new Map()
  const validPackages = new Set()
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (!entry.file) continue
    const file = await validatedArtifact(root, entry, signal)
    if (!file) continue
    accepted.set(entry, file)
    if (entry.format === 'uasset' || entry.format === 'umap') {
      validPackages.add(entry.path.normalize('NFC').toLowerCase().replace(/\.(uasset|umap)$/, ''))
    }
  }

  const published = []
  for (const row of entries) {
    signal?.throwIfAborted()
    const { file: staged, texture, textureIssue, ...entry } = row
    if (!staged) {
      published.push(entry)
      continue
    }
    const path = entry.path
    const file = accepted.get(row)
    const hasOwner = !companions.has(entry.format) ||
      validPackages.has(path.normalize('NFC').toLowerCase().replace(/\.(?:m\.)?(?:uexp|ubulk|uptnl)$/, ''))
    if (!file || !hasOwner) {
      published.push({ ...entry, status: 'skipped', issue: hasOwner ? 'unreal-pak-invalid-payload' : 'unreal-pak-orphan-companion' })
      continue
    }
    const category = categories[entry.format]
    const id = createHash('sha256').update(path).digest('hex').slice(0, 32)
    const destination = category ? [category, id, posix.basename(path)].join('/') : 'Source/' + path
    const artifact = await store.save(destination, file, {
      status: 'extracted', format: entry.format, method: 'cue4parse-pak', converterVersion: backendVersion,
    })
    const exports = artifact.path && (texture || textureIssue) ?
      [await publishTexture(root, store, row, artifact, id, path, backendVersion, signal)] : undefined
    published.push({ ...entry, id, status: artifact.status, artifact, ...(exports && { exports }) })
  }
  return published
}
