import { createWriteStream } from 'node:fs'
import { open, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { fileInfo, sameFile } from '../../../files/asset-files.mjs'

export const sameSource = (a, b) => sameFile(a, b) && a.dev === b.dev && a.ino === b.ino

export async function stageFile(root, file, destination, signal) {
  const handle = await open(file.path, 'r').catch(error => {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null
    throw error
  })
  if (!handle) return false
  try {
    const opened = await handle.stat()
    const before = await fileInfo(root, file.path)
    if (!before || !sameSource(opened, file.info) || !sameSource(before.info, opened)) return false
    signal?.throwIfAborted()
    if (opened.size === 0) {
      await writeFile(destination, '', { flag: 'wx', signal })
    } else {
      await pipeline(handle.createReadStream({ start: 0, end: opened.size - 1, autoClose: false }),
        createWriteStream(destination, { flags: 'wx' }), { signal })
    }
    const current = await fileInfo(root, file.path)
    return Boolean(current && sameSource(current.info, opened) && sameSource(await handle.stat(), opened) &&
      (await stat(destination)).size === opened.size)
  } finally {
    await handle.close()
  }
}
