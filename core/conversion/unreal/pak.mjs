import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { fileInfo } from '../../files/asset-files.mjs'
import { inspectUnrealFile } from '../../packages/unreal/inspect.mjs'
import { containerFileFolders, validateContainerFile } from './container-files.mjs'
import { publishContainerTexture } from './container-texture.mjs'
import { pakMaterialResolver, readPakMaterials } from './cooked-material/pak-inputs.mjs'
import { publishCookedMaterials } from './cooked-material/publish.mjs'

const companions = new Set(['uexp', 'ubulk', 'uptnl'])

async function validatedArtifact(root, entry, signal) {
  const file = await fileInfo(root, entry.file)
  if (!file || file.info.size !== entry.size) return null
  if (Object.hasOwn(containerFileFolders, entry.format)) {
    return await validateContainerFile(root, entry, file, signal) ? file : null
  }
  if (companions.has(entry.format)) return file
  const info = await inspectUnrealFile(root, { file, name: entry.path, type: entry.format }, signal)
  return ['editor', 'cooked', 'unversioned'].includes(info.storage) ? file : null
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

  const cooked = await readPakMaterials(entries, accepted, root, signal)
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
    const category = containerFileFolders[entry.format]
    const id = createHash('sha256').update(path).digest('hex').slice(0, 32)
    const destination = category ? [category, id, posix.basename(path)].join('/') : 'Source/' + path
    const artifact = await store.save(destination, file, {
      status: 'extracted', format: entry.format, method: 'cue4parse-pak', converterVersion: backendVersion,
    })
    const exports = artifact.path && (texture || textureIssue) ?
      [await publishContainerTexture(root, store, row, artifact, id, { method: 'cue4parse-cooked-texture',
        converterVersion: backendVersion, outputIssue: 'unreal-cooked-texture-output' }, signal)] : undefined
    published.push({ ...entry, id, status: artifact.status, artifact, ...(exports && { exports }) })
  }
  const materials = await publishCookedMaterials(published, cooked, root, store, pakMaterialResolver(published), signal)
  return { entries: published, ...materials }
}
