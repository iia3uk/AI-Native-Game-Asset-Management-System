import { open } from 'node:fs/promises'
import { isSerializedUnity, serializedProbeSize } from '../engines/unity/serialized/header.mjs'
import { checkedPath, fileInfo, sameFile } from '../files/asset-files.mjs'
import { IndexInputError } from '../index/index-errors.mjs'
import { pakFooter } from './unreal/containers.mjs'
import { hasUnrealPackageMagic } from './unreal/package-summary.mjs'
import { unrealFileType } from './unreal/source.mjs'
import { unityFolderFormat } from './unity/folder/layout.mjs'
import { unrealLooseSource } from './unreal/loose/source.mjs'

export const unityFsMagic = Buffer.from('UnityFS\0')

export async function detectPackage(source, { signal } = {}) {
  signal?.throwIfAborted()
  const format = source.directory ? await unityFolderFormat(source.root) : await probePackageFormat(source, { signal })
  if (format) return format
  const loose = await unrealLooseSource(source, signal)
  if (loose) return loose.format
  if (source.directory) throw new IndexInputError('Выберите проект Unity, папку UPM, проект Unreal или папку Unreal Content.')
  throw new IndexInputError('Ожидается Unity Package, UnityFS, бинарный файл Unity или Unreal Pak, .uasset, .umap либо .uproject.')
}

export async function probePackageFormat(source, { signal, looseUnreal = false } = {}) {
  signal?.throwIfAborted()
  const changed = () => new IndexInputError('Исходный пакет изменился или стал недоступен.')
  const file = await fileInfo(source.root, source.path)
  if (!file) throw changed()
  const handle = await open(file.path, 'r')
  try {
    if (!sameFile(file.info, await handle.stat()) || !await checkedPath(source.root, source.path)) throw changed()
    const prefix = Buffer.alloc(serializedProbeSize)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    let format = null
    if (bytesRead >= unityFsMagic.length && prefix.subarray(0, unityFsMagic.length).equals(unityFsMagic)) format = 'unityfs'
    else if (bytesRead >= 2 && prefix[0] === 0x1f && prefix[1] === 0x8b) format = 'unitypackage'
    else if (isSerializedUnity(prefix.subarray(0, bytesRead), file.info.size)) format = 'unity-serialized'
    else if (looseUnreal && ['uasset', 'umap'].includes(unrealFileType(file.path)) &&
        hasUnrealPackageMagic(prefix.subarray(0, bytesRead))) format = 'unreal-asset'
    else if (file.info.size >= 45) {
      const footer = Buffer.alloc(Math.min(file.info.size, 1024))
      const start = file.info.size - footer.length
      let read = 0
      while (read < footer.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(footer, read, footer.length - read, start + read)
        if (!bytesRead) throw changed()
        read += bytesRead
      }
      if (pakFooter(footer, file.info.size)) format = 'unreal-pak'
    }
    if (!sameFile(file.info, await handle.stat())) throw changed()
    return format
  } finally {
    await handle.close()
  }
}
