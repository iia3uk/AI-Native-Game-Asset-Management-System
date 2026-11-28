import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { checkedPath, fileInfo } from '../../files/asset-files.mjs'
import { readVerifiedFile } from '../../files/read-verified.mjs'
import { IndexConflictError } from '../../index/index-errors.mjs'

export async function verifyPublishedPackage(reservation, files, reports, signal) {
  const directory = join(reservation.path, 'Package')
  const info = await lstat(directory).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return null
  const changed = () => new IndexConflictError('Ранее экспортированные файлы изменились. Проверьте папку назначения.')
  if (!info.isDirectory() || !await checkedPath(reservation.path, directory)) throw changed()
  const documents = Object.entries(reports).map(([name, report]) => ({
    path: name + '.json', info: { size: Buffer.byteLength(report) },
    sha256: createHash('sha256').update(report).digest('hex'),
  }))
  for (const expected of [...files, ...documents]) {
    signal.throwIfAborted()
    const file = await fileInfo(directory, expected.path)
    if (!file || file.info.size !== expected.info.size) throw changed()
    const { hash } = await readVerifiedFile(directory, file, { changed, signal })
    if (hash !== expected.sha256) throw changed()
  }
  return directory
}
