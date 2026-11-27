import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { checkedPath, sameFile, ScanChangeError } from './asset-files.mjs'

export const sameSource = (a, b) => sameFile(a, b) && a.dev === b.dev && a.ino === b.ino

export async function hashFile(root, path, expected, signal) {
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat()
    const changed = () => new ScanChangeError('Файл изменился во время индексации. Повторите сканирование.')
    if (!opened.isFile() || !sameSource(opened, expected) || !await checkedPath(root, path)) throw changed()
    const hash = createHash('sha256')
    let length = 0
    if (opened.size) {
      const stream = handle.createReadStream({ start: 0, end: opened.size - 1, autoClose: false, signal })
      for await (const bytes of stream) {
        length += bytes.length
        hash.update(bytes)
      }
    }
    if (length !== opened.size || !sameSource(opened, await handle.stat())) throw changed()
    signal?.throwIfAborted()
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
