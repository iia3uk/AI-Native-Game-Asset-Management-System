import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { checkedPath } from '../../../files/asset-files.mjs'
import { sameSource } from '../../../files/hash.mjs'
import { invalid } from '../policy.mjs'

export const folderChanged = () => invalid('содержимое папки изменилось. Проанализируйте её снова.')

export async function readFolderFile(root, file, { temporary, metadata, signal }) {
  signal?.throwIfAborted()
  if (!await checkedPath(root, file.path)) throw folderChanged()
  const input = await open(file.path, 'r')
  try {
    const opened = await input.stat()
    if (!opened.isFile() || !sameSource(opened, file.info) || !await checkedPath(root, file.path)) throw folderChanged()
    const output = temporary && await open(temporary, 'wx')
    const hash = createHash('sha256')
    const prefix = metadata && Buffer.alloc(Math.min(opened.size, 16 * 1024))
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
    if (length !== opened.size || !sameSource(opened, await input.stat()) || !await checkedPath(root, file.path)) {
      throw folderChanged()
    }
    return { size: length, hash: hash.digest('hex'), temp: temporary,
      ...(metadata && { guid: /^guid:[ \t]*([0-9a-f]{32})[ \t]*\r?$/im.exec(prefix.toString('utf8'))?.[1].toLowerCase() }) }
  } finally {
    await input.close()
  }
}
