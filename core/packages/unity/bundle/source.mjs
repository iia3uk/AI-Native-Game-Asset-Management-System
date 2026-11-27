import { open } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { inputLimit } from '../../../engines/unity/bundle/run.mjs'
import { sameSource } from '../../../files/hash.mjs'
import { companionSizeAllowed, findSerializedCompanions } from '../../../engines/unity/serialized/companions.mjs'
import { isSerializedUnity, serializedProbeSize } from '../../../engines/unity/serialized/header.mjs'
import { checkedPath, fileInfo, folderPath } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'
import { unityFsMagic } from '../../detect.mjs'

export async function selectBundlePath(input) {
  const path = typeof input === 'string' ? input.trim().replace(/^"(.*)"$/, '$1') : ''
  if (path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) {
    throw new IndexInputError('Укажите полный путь к локальному Unity AssetBundle.')
  }
  const root = await folderPath(dirname(path)).catch(() => null)
  if (!root) throw new IndexInputError('Выберите доступный файл Unity AssetBundle.')
  return { root, path: basename(path), name: basename(path) }
}

export async function readBundleSource({ root, path, name }, serialized, signal) {
  const file = await fileInfo(root, path)
  if (!file) throw new IndexInputError('Выберите доступный бинарный файл Unity.')
  if (file.info.size < 48 || file.info.size > inputLimit) return { status: 'failed', issue: 'unity-bundle-input-size' }
  signal?.throwIfAborted()
  const handle = await open(file.path, 'r')
  try {
    if (!sameSource(await handle.stat(), file.info) || !await checkedPath(root, path)) {
      return { status: 'failed', issue: 'unity-bundle-source-changed' }
    }
    const bytes = Buffer.alloc(serialized ? serializedProbeSize : unityFsMagic.length)
    const { bytesRead } = await handle.read(bytes)
    const valid = serialized ? isSerializedUnity(bytes.subarray(0, bytesRead), file.info.size) :
      bytesRead === bytes.length && bytes.equals(unityFsMagic)
    if (!valid) {
      return { status: 'failed', issue: 'unity-bundle-signature' }
    }
  } finally {
    await handle.close()
  }
  const resources = serialized ? await findSerializedCompanions(root, file.path) : []
  if (!companionSizeAllowed(resources)) return { status: 'failed', issue: 'unity-bundle-companion-size' }
  return { root, file, name, serialized, resources }
}
