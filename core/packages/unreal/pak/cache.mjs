import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyExports } from '../../../conversion/cache.mjs'
import { cue4parseVersion } from '../../../engines/unreal/decoder/run.mjs'
import { checkedPath, fileInfo, readBoundedText } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'

export const pakRecipe = createHash('sha256').update(JSON.stringify([1, cue4parseVersion])).digest('hex').slice(0, 24)
export const pakMethod = 'cue4parse-pak'

export async function readPakCache(root, hash, sourceName, signal) {
  const output = join(root, hash + '-' + pakRecipe)
  const existing = await lstat(output).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!existing) return null
  try {
    if (!existing.isDirectory() || !await checkedPath(root, output)) throw new Error('Invalid cache path')
    const [manifestText, summaryText, dependencies] = await Promise.all([
      readBoundedText(output, 'manifest.json', 64 * 1024 ** 2),
      readBoundedText(output, 'conversion-report.json', 64 * 1024),
      fileInfo(output, 'dependencies.json'),
    ])
    const manifest = JSON.parse(manifestText)
    const report = JSON.parse(summaryText)
    const entries = manifest?.entries
    if (!dependencies || manifest.source?.sha256 !== hash || manifest.recipe !== pakRecipe || manifest.version !== 1 ||
        report?.method !== pakMethod || report.converterVersion !== cue4parseVersion ||
        !Array.isArray(entries) || entries.length > 10_000 || report.total !== entries.length) throw new Error('Invalid cache metadata')
    const extracted = entries.filter(entry => entry.status === 'extracted')
    if (extracted.length !== report.extracted || report.skipped !== entries.length - extracted.length ||
        report.counts?.extracted !== report.extracted || report.counts?.skipped !== report.skipped ||
        report.status !== (extracted.length ? 'completed' : 'no-compatible-inputs') ||
        extracted.some(entry => !entry.artifact?.path) ||
        !await verifyExports(output, extracted.map(entry => ({ exports: [entry.artifact] })), signal)) {
      throw new Error('Invalid cached exports')
    }
    return { ...report, output, sourceName, reused: true,
      ...(!report.extracted && { entries: entries.slice(0, 500) }) }
  } catch {
    signal?.throwIfAborted()
    throw new IndexInputError('Кеш импорта Unreal Pak повреждён.')
  }
}
