import { relative } from 'node:path'
import { pathKey, portablePath, ScanChangeError } from '../../../files/asset-files.mjs'
import { hashFile, sameSource } from '../../../files/hash.mjs'
import { ioStoreFingerprint, ioStoreSource } from './source.mjs'
import { completeIoStoreFiles } from './watch-completeness.mjs'

export async function watchIoStoreSource(root, toc, files, previousResources, signal) {
  const source = await ioStoreSource({ root, path: toc.absolute }, signal)
  if (source.issue || !await completeIoStoreFiles(source, signal)) return null
  const previous = JSON.parse(previousResources ?? '[]')
  const resources = []
  for (const { file, name } of source.files) {
    const indexed = files.get(pathKey(portablePath(relative(root, file.path))))
    if (!indexed || !sameSource(indexed.info, file.info)) {
      throw new ScanChangeError('Контейнер Unreal IoStore изменился во время индексации. Повторите сканирование.')
    }
    const { size, mtimeMs, ctimeMs, dev, ino } = file.info
    const cached = previous.find(entry => entry.name === name && sameSource(entry, file.info))
    const sha256 = indexed.freshHash ?? cached?.sha256 ?? await hashFile(root, file.path, file.info, signal)
    resources.push({ name, size, mtimeMs, ctimeMs, dev, ino, sha256 })
  }
  return { key: ioStoreFingerprint(resources), resources: JSON.stringify(resources) }
}
