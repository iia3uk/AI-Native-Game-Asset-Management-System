import { realpath } from 'node:fs/promises'
import { checkedPath, readBoundedText } from '../files/asset-files.mjs'
import { IndexInputError } from '../index/index-errors.mjs'

export async function packageManifestPage(importDirectory, job, offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new IndexInputError('Недопустимые параметры страницы.')
  }
  if (job?.type !== 'package-import' || !job.result?.directory) return null
  const root = await realpath(importDirectory).catch(() => null)
  const directory = root && await checkedPath(root, job.result.directory)
  if (!directory) return null
  const manifest = await readBoundedText(directory, 'manifest.json', 64 * 1024 ** 2)
  if (!manifest) return null
  const { source, assets: unityAssets, entries: pakEntries } = JSON.parse(manifest)
  const assets = job.result.report?.packageFormat === 'unreal-pak' ? pakEntries : unityAssets
  if (source?.sha256 !== job.sourceKey || !Array.isArray(assets)) return null
  return { assets: assets.slice(offset, offset + limit), total: assets.length,
    nextOffset: offset + limit < assets.length ? offset + limit : null }
}
