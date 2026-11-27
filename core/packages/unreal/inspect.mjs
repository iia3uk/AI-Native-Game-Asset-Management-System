import { open } from 'node:fs/promises'
import { checkedPath, sameFile } from '../../files/asset-files.mjs'
import { IndexInputError } from '../../index/index-errors.mjs'
import { pakFooter, ioStoreHeader } from './containers.mjs'
import { unrealPackageSummary } from './package-summary.mjs'
import { unrealContentFiles, unrealSource } from './source.mjs'

export async function inspectUnrealFile(root, { file, name, type }, signal) {
  const size = file.info.size
  const details = { path: name, type, size }
  if (!['uasset', 'umap', 'pak', 'utoc'].includes(type)) return { ...details, storage: 'companion' }
  signal?.throwIfAborted()
  const handle = await open(file.path, 'r')
  try {
    if (!sameFile(file.info, await handle.stat()) || !await checkedPath(root, file.path)) {
      throw new IndexInputError('Файл Unreal изменился во время анализа.')
    }
    const limit = type === 'pak' ? 1024 : type === 'utoc' ? 144 : 48 * 1024
    const bytes = Buffer.alloc(Math.min(size, limit))
    const position = type === 'pak' ? size - bytes.length : 0
    let read = 0
    while (read < bytes.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, position + read)
      if (!bytesRead) break
      read += bytesRead
    }
    if (read !== bytes.length || !sameFile(file.info, await handle.stat())) {
      throw new IndexInputError('Файл Unreal изменился во время анализа.')
    }
    if (type === 'uasset' || type === 'umap') return { ...details, ...unrealPackageSummary(bytes, size) }
    const container = type === 'pak' ? pakFooter(bytes, size) : ioStoreHeader(bytes, size)
    return { ...details, ...(container ? { storage: 'container', ...container } :
      { storage: 'unknown', issue: 'unreal-container-signature' }) }
  } finally {
    await handle.close()
  }
}

export async function collectUnrealContent(source, signal) {
  const entries = []
  for await (const entry of unrealContentFiles(source.root, signal)) {
    entries.push({ file: entry.file, ...await inspectUnrealFile(source.root, entry, signal) })
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

export async function inspectUnreal(input, { signal } = {}) {
  const source = await unrealSource(input)
  const { type, name, association, descriptorVersion } = source
  if (type === 'uplugin') return { type, name, descriptorVersion }
  if (!['content', 'uproject'].includes(type)) return inspectUnrealFile(source.root, source, signal)
  const entries = await collectUnrealContent(source, signal)
  const counts = Object.create(null)
  for (const entry of entries) counts[entry.storage] = (counts[entry.storage] ?? 0) + 1
  return { type, name, association, descriptorVersion, counts, total: entries.length,
    entries: entries.slice(0, 500).map(({ file, ...entry }) => entry) }
}
