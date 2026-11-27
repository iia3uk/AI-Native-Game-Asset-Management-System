import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyExports } from '../../../conversion/cache.mjs'
import { bundleDecoderRevision } from '../../../engines/unity/bundle/protocol.mjs'
import { assetsToolsVersion } from '../../../engines/unity/bundle/run.mjs'
import { checkedPath, fileInfo, readBoundedText } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'

export const bundleVersion = 1

export function bundleRecipe(withFbx, blender, method) {
  return createHash('sha256')
    .update(JSON.stringify([bundleVersion, assetsToolsVersion, bundleDecoderRevision, method, withFbx, blender?.identity ?? null]))
    .digest('hex').slice(0, 24)
}

export async function readBundleCache(root, { sha256, contentsSha256, resources }, recipe, sourceName, method, signal) {
  const output = join(root, sha256 + '-' + recipe)
  const existing = await lstat(output).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!existing) return null
  try {
    if (!existing.isDirectory() || !await checkedPath(root, output)) throw new Error('Invalid cache path')
    const [manifest, summary, dependencies] = await Promise.all([
      readBoundedText(output, 'manifest.json', 64 * 1024 ** 2),
      readBoundedText(output, 'conversion-report.json', 64 * 1024),
      fileInfo(output, 'dependencies.json'),
    ])
    const { source, version, recipe: cachedRecipe, decoderRevision, assets, method: cachedMethod } = JSON.parse(manifest)
    const report = JSON.parse(summary)
    if (!dependencies || source?.sha256 !== sha256 || source.contentsSha256 !== contentsSha256 ||
        JSON.stringify(source.resources) !== JSON.stringify(resources) ||
        version !== bundleVersion || cachedRecipe !== recipe ||
        cachedMethod !== method || report?.method !== method || report.converterVersion !== assetsToolsVersion ||
        decoderRevision !== bundleDecoderRevision || report.decoderRevision !== decoderRevision || !Array.isArray(assets) ||
        assets.length !== report.total || assets.length > 10_000 ||
        report.converted !== assets.filter(asset => asset.status === 'converted').length ||
        report.skipped !== report.total - report.converted ||
        report.status !== (report.converted ? 'completed' : 'no-compatible-inputs')) throw new Error('Invalid cache metadata')
    const entries = assets.map(asset => {
      if (asset.status === 'converted' && !asset.artifact?.path) throw new Error('Missing decoded artifact')
      return { exports: [asset.artifact, ...(asset.exports ?? [])].filter(Boolean) }
    })
    if (!await verifyExports(output, entries, signal)) throw new Error('Invalid cached exports')
    return { ...report, output, sourceName, reused: true }
  } catch {
    signal?.throwIfAborted()
    throw new IndexInputError('Кеш декодирования Unity повреждён.')
  }
}
