import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { checkedPath, fileInfo, sameFile } from '../files/asset-files.mjs'

const thumbnailVersion = 1
export const thumbnailSize = 160
const maxSourceBytes = 32 * 1024 ** 2
const maxObjBytes = 4 * 1024 ** 2
const maxBuffers = 16
const formats = new Set(['glb', 'vrm', 'gltf', 'obj'])
const changedMessage = 'Исходный файл или буфер изменился. Обновите индекс.'

export function thumbnailPlan(asset, dependencies) {
  if (!formats.has(asset.ext)) return { status: 'unsupported' }
  if (asset.missingSince || !asset.hash) return { status: 'unavailable' }
  if (dependencies.some(file => file.location !== 'local' || !file.hash)) return { status: 'unavailable' }
  if (dependencies.length > maxBuffers || asset.size > (asset.ext === 'obj' ? maxObjBytes : maxSourceBytes) ||
      asset.size + dependencies.reduce((sum, file) => sum + file.size, 0) > maxSourceBytes) return { status: 'limited' }
  const key = createHash('sha256').update(JSON.stringify([
    thumbnailVersion, thumbnailSize, asset.ext, asset.hash,
    dependencies.map(file => [file.reference, file.hash]),
  ])).digest('hex')
  return { ...asset, status: 'ready', key, dependencies }
}

function matches(file, info) {
  return info.size === file.size && info.mtimeMs === file.mtime && info.ctimeMs === file.ctime
}

export async function thumbnailCurrent(plan) {
  for (const file of [plan, ...plan.dependencies]) {
    const current = await fileInfo(plan.root, file.path)
    if (!current || !matches(file, current.info)) return false
  }
  return true
}

export async function readThumbnailSource(root, source) {
  const file = await fileInfo(root, source.path)
  if (!file || !matches(source, file.info)) throw new Error(changedMessage)
  const handle = await open(file.path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || !sameFile(file.info, info) || !await checkedPath(root, file.path)) throw new Error(changedMessage)
    const data = Buffer.alloc(source.size + 1)
    let length = 0
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const result = data.subarray(0, length)
    if (length !== source.size || !sameFile(info, await handle.stat()) ||
        createHash('sha256').update(result).digest('hex') !== source.hash) throw new Error(changedMessage)
    return result
  } finally {
    await handle.close()
  }
}
