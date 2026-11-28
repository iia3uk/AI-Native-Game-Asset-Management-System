import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExportArtifacts } from '../../artifacts.mjs'
import { checkedPath, fileInfo, sameFile } from '../../../files/asset-files.mjs'
import { unrealSourceMedia } from './payload.mjs'

const maxCandidateSize = 128 * 1024 ** 2
const folders = { audio: 'Audio', texture: 'Textures' }

async function readPackage(root, path, signal) {
  const file = await fileInfo(root, path)
  if (!file || !file.info.size || file.info.size > maxCandidateSize) return null
  const input = await open(file.path, 'r')
  try {
    if (!sameFile(file.info, await input.stat()) || !await checkedPath(root, file.path)) return null
    const bytes = Buffer.allocUnsafe(file.info.size)
    let offset = 0
    while (offset < bytes.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await input.read(bytes, offset, Math.min(bytes.length - offset, 4 * 1024 ** 2), offset)
      if (!bytesRead) return null
      offset += bytesRead
    }
    return sameFile(file.info, await input.stat()) && await checkedPath(root, file.path) ? bytes : null
  } finally {
    await input.close()
  }
}

export async function recoverUnrealMedia(records, { output, workspace, signal, onProgress }) {
  const store = new ExportArtifacts(output, signal, 8 * 1024 ** 3)
  const scratch = join(workspace, 'source-media')
  await mkdir(scratch)
  const counts = { png: 0, wav: 0 }
  for (const [index, asset] of records.assets.entries()) {
    signal?.throwIfAborted()
    onProgress?.(Math.floor(100 * index / records.assets.length))
    if (!asset.output || asset.type !== 'uasset' || asset.storage !== 'editor' || asset.ue5 !== 0 ||
        asset.exports.some(item => folders[item.role] && item.status === 'converted')) continue
    const input = await readPackage(output, asset.output, signal)
    const media = input && unrealSourceMedia(input, signal)
    if (!media) continue
    const { bytes, ...metadata } = media
    const details = { ...metadata, status: 'converted', method: 'unreal-editor-source-media', from: asset.output }
    const error = await store.preflight(bytes.length)
    if (error) {
      asset.exports.push({ ...details, status: 'failed', issue: error })
      continue
    }
    const temporary = join(scratch, asset.id)
    await writeFile(temporary, bytes, { flag: 'wx', signal })
    const path = folders[media.role] + '/' + asset.sourcePath.replace(/\.uasset$/i, '.' + media.format)
    const saved = await store.save(path, { path: temporary, info: { size: bytes.length } }, details)
    asset.exports.push(saved)
    if (saved.path) {
      asset.status = 'converted'
      counts[media.format]++
    }
  }
  return counts
}
