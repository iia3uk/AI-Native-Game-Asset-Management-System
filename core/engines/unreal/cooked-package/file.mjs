import { open } from 'node:fs/promises'
import { checkedPath, sameFile } from '../../../files/asset-files.mjs'
import { cookedHeaderSize, cookedPackage } from './tables.mjs'

const summaryLimit = 28 + 256 * 20

export async function readCookedRange(root, file, size, offset, signal) {
  const handle = await open(file.path, 'r')
  try {
    if (!sameFile(file.info, await handle.stat()) || !await checkedPath(root, file.path)) return null
    const bytes = Buffer.alloc(size)
    for (let read = 0; read < size;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, read, size - read, offset + read)
      if (!bytesRead) return null
      read += bytesRead
    }
    return sameFile(file.info, await handle.stat()) ? bytes : null
  } finally { await handle.close() }
}

export async function readCookedTables(root, file, signal) {
  const prefix = await readCookedRange(root, file, Math.min(file.info.size, summaryLimit), 0, signal)
  const headerSize = prefix && cookedHeaderSize(prefix, file.info.size)
  if (!headerSize) return null
  const header = await readCookedRange(root, file, headerSize, 0, signal)
  return header && cookedPackage(header)
}
