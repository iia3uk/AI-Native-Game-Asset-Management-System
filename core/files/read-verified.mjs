import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { checkedPath } from './asset-files.mjs'
import { sameSource } from './hash.mjs'

export async function readVerifiedFile(root, file, { temporary, capture = 0, signal, changed }) {
  signal?.throwIfAborted()
  if (!await checkedPath(root, file.path)) throw changed()
  const input = await open(file.path, 'r')
  try {
    const opened = await input.stat()
    if (!opened.isFile() || !sameSource(opened, file.info) || !await checkedPath(root, file.path)) throw changed()
    const output = temporary && await open(temporary, 'wx')
    const hash = createHash('sha256')
    const prefix = capture ? Buffer.alloc(Math.min(opened.size, capture)) : null
    let length = 0
    try {
      if (opened.size) for await (const chunk of input.createReadStream({
        start: 0, end: opened.size - 1, autoClose: false, signal,
      })) {
        if (prefix && length < prefix.length) chunk.copy(prefix, length)
        length += chunk.length
        hash.update(chunk)
        if (output) {
          let offset = 0
          while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten
        }
      }
    } finally {
      await output?.close()
    }
    if (length !== opened.size || !sameSource(opened, await input.stat()) || !await checkedPath(root, file.path)) throw changed()
    return { size: length, hash: hash.digest('hex'), prefix, temp: temporary }
  } finally {
    await input.close()
  }
}
