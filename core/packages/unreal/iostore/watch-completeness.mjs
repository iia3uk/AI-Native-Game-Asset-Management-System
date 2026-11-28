import { open } from 'node:fs/promises'
import { checkedPath, ScanChangeError } from '../../../files/asset-files.mjs'
import { sameSource } from '../../../files/hash.mjs'

const headerSize = 144
const blockWidth = 12

// Check physical byte ranges before hashing a UCAS file that may still be copying.
// The worker independently validates and decodes the staged container.
export async function completeIoStoreFiles({ root, version, files }, signal) {
  const [{ file: toc }, ...partitions] = files
  const handle = await open(toc.path, 'r')
  const changed = () => new ScanChangeError('Оглавление IoStore изменилось во время индексации.')
  try {
    if (!sameSource(toc.info, await handle.stat()) || !await checkedPath(root, toc.path)) throw changed()
    const header = Buffer.alloc(headerSize)
    if (!await readAt(handle, header, 0, signal)) return false
    const chunks = header.readUInt32LE(24)
    const blocks = header.readUInt32LE(28)
    const methods = header.readUInt32LE(36)
    const methodWidth = header.readUInt32LE(40)
    const directorySize = header.readUInt32LE(48)
    const seeds = version >= 4 ? header.readUInt32LE(84) : 0
    const overflow = version >= 5 ? header.readUInt32LE(96) : 0
    if (header.readUInt32LE(20) !== headerSize || header.readUInt32LE(32) !== blockWidth ||
        !chunks || chunks > 100_000 || !blocks || blocks > 250_000 ||
        methods > 16 || methodWidth > 32 || seeds > chunks || overflow > chunks) return false
    const start = headerSize + chunks * 22 + (seeds + overflow) * 4
    const metadataWidth = version < 8 ? 33 : 24
    const bytes = blocks * blockWidth
    if (start + bytes + methods * methodWidth + directorySize + chunks * metadataWidth !== toc.info.size) return false
    const partitionSize = version < 3 ? Infinity : Number(header.readBigUInt64LE(88))
    const lengths = partitions.map(({ file }) => file.info.size)
    if (!partitionSize || lengths.some(size => size > partitionSize)) return false
    const table = Buffer.alloc(bytes)
    if (!await readAt(handle, table, start, signal)) return false
    if (!sameSource(toc.info, await handle.stat())) throw changed()
    for (let index = 0; index < bytes; index += blockWidth) {
      const offset = table.readUIntLE(index, 5)
      const size = table.readUIntLE(index + 5, 3)
      const partition = Math.floor(offset / partitionSize)
      if (!size || partition >= lengths.length || offset % partitionSize + size > lengths[partition]) return false
    }
    return true
  } finally {
    await handle.close()
  }
}

async function readAt(handle, buffer, start, signal) {
  let length = 0
  while (length < buffer.length) {
    signal?.throwIfAborted()
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, start + length)
    if (!bytesRead) return false
    length += bytesRead
  }
  return true
}
