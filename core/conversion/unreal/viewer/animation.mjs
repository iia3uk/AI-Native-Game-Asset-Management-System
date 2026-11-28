import { open } from 'node:fs/promises'
import { fileInfo } from '../../../files/asset-files.mjs'

const chunks = new Map([['ANIMHEAD', 0], ['BONENAMES', 120], ['ANIMINFO', 168], ['ANIMKEYS', 32], ['SCALEKEYS', 16]])

export async function viewerAnimation(root, path, signal) {
  const file = await fileInfo(root, path)
  if (!file || file.info.size < 128 || file.info.size > 128 * 1024 ** 2) return null
  const handle = await open(file.path, 'r')
  try {
    const metadata = {}
    let offset = 0
    const header = Buffer.alloc(32)
    for (const [chunk, stride] of chunks) {
      signal?.throwIfAborted()
      if (chunk === 'SCALEKEYS' && offset === file.info.size) break
      if ((await handle.read(header, 0, header.length, offset)).bytesRead !== header.length) return null
      const items = header.readInt32LE(28)
      if (header.toString('ascii', 0, 20).split('\0', 1)[0] !== chunk || header.readInt32LE(24) !== stride ||
          (chunk === 'ANIMHEAD' ? items !== 0 : items < (chunk === 'SCALEKEYS' ? 0 : 1))) return null
      offset += header.length + items * stride
      if (offset > file.info.size) return null
      if (chunk === 'BONENAMES') metadata.bones = items
      if (chunk === 'ANIMINFO') metadata.sequences = items
      if (chunk === 'ANIMKEYS') metadata.keys = items
    }
    return offset === file.info.size ? { file, metadata } : null
  } finally {
    await handle.close()
  }
}
