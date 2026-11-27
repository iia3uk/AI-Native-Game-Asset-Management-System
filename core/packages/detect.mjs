import { open } from 'node:fs/promises'
import { checkedPath, fileInfo, sameFile } from '../files/asset-files.mjs'
import { IndexInputError } from '../index/index-errors.mjs'

export const unityFsMagic = Buffer.from('UnityFS\0')

export async function detectPackage(source) {
  const changed = () => new IndexInputError('Исходный пакет изменился или стал недоступен.')
  const file = await fileInfo(source.root, source.path)
  if (!file) throw changed()
  const handle = await open(file.path, 'r')
  try {
    if (!sameFile(file.info, await handle.stat()) || !await checkedPath(source.root, source.path)) throw changed()
    const prefix = Buffer.alloc(unityFsMagic.length)
    const { bytesRead } = await handle.read(prefix)
    if (bytesRead === prefix.length && prefix.equals(unityFsMagic)) return 'unityfs'
    if (bytesRead >= 2 && prefix[0] === 0x1f && prefix[1] === 0x8b) return 'unitypackage'
    throw new IndexInputError('Ожидается архив .unitypackage (TAR.GZ) или контейнер UnityFS.')
  } finally {
    await handle.close()
  }
}
