import { open } from 'node:fs/promises'
import { checkedPath, fileInfo, sameFile } from '../files/asset-files.mjs'
import { IndexInputError } from '../index/index-errors.mjs'
import { inspectUnrealFile } from './unreal/inspect.mjs'

export const unityFsMagic = Buffer.from('UnityFS\0')

export async function detectPackage(source, { signal } = {}) {
  signal?.throwIfAborted()
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
  } finally {
    await handle.close()
  }
  const footer = await inspectUnrealFile(source.root, { ...source, file, type: 'pak' }, signal)
  if (footer.storage === 'container') return 'unreal-pak'
  throw new IndexInputError('Ожидается архив Unity Package, UnityFS или Unreal Pak.')
}
