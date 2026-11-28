import { createHash } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { classification, unitySummary } from '../records.mjs'
import { invalid, MiB, packageLimits } from '../policy.mjs'
import { folderInventory } from './inventory.mjs'
import { unityFolderLayout } from './layout.mjs'
import { folderChanged, readFolderFile } from './read-file.mjs'

export async function readUnityFolder(source, { staging, signal, onProgress, limits }) {
  const { root } = source
  const { format, engineVersion, packages, mounts, fingerprint } = await unityFolderLayout(root, signal)
  const inventory = await folderInventory(root, mounts, limits, signal)
  const assets = []
  const ids = new Map()
  const hash = createHash('sha256').update(JSON.stringify(['unity-folder-v1', format, fingerprint]))
  let size = 0
  let stagedSize = 0
  let nextSpaceCheck = 0
  for (const { path, file, metadata } of inventory.rows) {
    signal?.throwIfAborted()
    const fields = classification(path, !file)
    const allowed = fields.status !== 'unsupported'
    const payload = allowed && file ? await read(file, 'asset', limits.entry, true) : undefined
    const meta = metadata && await read(metadata, 'meta', limits.metadata, allowed)
    const id = meta?.guid ?? createHash('sha256').update('asset-viewer-folder-id-v1\0' + path).digest('hex').slice(0, 32)
    if (ids.has(id)) throw invalid('GUID повторяется у ' + ids.get(id) + ' и ' + path + '.')
    ids.set(id, path)
    const length = file?.info.size ?? 0
    hash.update(JSON.stringify([path, Boolean(file), length, payload?.hash, meta?.hash]))
    assets.push({ id, sourcePath: path, ...fields, size: length, hasMeta: Boolean(meta?.guid), hasPreview: false,
      ...(meta && !meta.guid && { issue: 'metadata-guid-invalid' }), payload, meta: meta?.guid ? meta : undefined })
    const progress = Math.floor(60 * assets.length / inventory.rows.length)
    onProgress?.(progress)
  }
  await inventory.verify()
  const current = await unityFolderLayout(root, signal)
  if (current.format !== format || JSON.stringify(current.mounts) !== JSON.stringify(mounts) ||
      JSON.stringify(current.fingerprint) !== JSON.stringify(fingerprint)) throw folderChanged()
  if (!assets.length) throw invalid('в папке отсутствуют записи ресурсов Unity.')
  return { format, engineVersion, packages, size, hash: hash.digest('hex'), assets }

  async function read(file, kind, limit, write) {
    const length = file.info.size
    if (length > limit || size + length > limits.unpacked) throw invalid('превышен лимит размера исходных ресурсов.')
    size += length
    const temporary = staging && write ? join(staging, 'folder-' + assets.length + '-' + kind) : undefined
    if (temporary) {
      stagedSize += length
      if (stagedSize >= nextSpaceCheck) {
        const space = await statfs(staging, { bigint: true })
        if (space.bavail * space.bsize < BigInt(length + 160 * MiB)) throw invalid('недостаточно свободного места.')
        nextSpaceCheck = stagedSize + 32 * MiB
      }
    }
    return readFolderFile(root, file, { temporary, metadata: kind === 'meta', signal })
  }
}

export async function inspectUnityFolder(source, { signal, limits = packageLimits } = {}) {
  return unitySummary(await readUnityFolder(source, { signal, limits }))
}
