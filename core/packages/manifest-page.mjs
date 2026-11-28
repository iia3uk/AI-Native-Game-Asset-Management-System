import { realpath } from 'node:fs/promises'
import { checkedPath, readBoundedText } from '../files/asset-files.mjs'
import { IndexInputError } from '../index/index-errors.mjs'
import { availablePackageAssets } from './cleanup/retired.mjs'

export async function readPackageDocument(directory, name) {
  const text = await readBoundedText(directory, name + '.json', 64 * 1024 ** 2)
  if (text === null) return null
  try { return { text, data: JSON.parse(text) } } catch { return null }
}

export async function readPackageResult(importDirectory, job) {
  if (job?.type !== 'package-import' || job.status !== 'completed' || !job.result?.directory) return null
  const root = await realpath(importDirectory).catch(() => null)
  const directory = root && await checkedPath(root, job.result.directory)
  if (!directory || directory === root) return null
  const manifest = await readPackageDocument(directory, 'manifest')
  const pak = job.result.report?.packageFormat === 'unreal-pak'
  const assets = pak ? manifest?.data?.entries : manifest?.data?.assets
  if (manifest?.data?.source?.sha256 !== job.sourceKey || !Array.isArray(assets)) return null
  return { root, directory, manifest, assets, pak }
}

export async function packageManifestPage(importDirectory, job, offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new IndexInputError('Недопустимые параметры страницы.')
  }
  const result = await readPackageResult(importDirectory, job)
  if (!result) return null
  const assets = await availablePackageAssets(result.directory, result.assets)
  return { assets: assets.slice(offset, offset + limit), total: assets.length,
    nextOffset: offset + limit < assets.length ? offset + limit : null }
}
