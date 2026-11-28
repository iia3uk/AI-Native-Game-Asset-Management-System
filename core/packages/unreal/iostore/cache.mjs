import { join } from 'node:path'
import { verifyExports } from '../../../conversion/cache.mjs'
import { ioStoreMethod } from '../../../conversion/unreal/iostore.mjs'
import { cue4parseVersion } from '../../../engines/unreal/decoder/run.mjs'
import { checkedPath } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'
import { readPackageDocument } from '../../manifest-page.mjs'
import { ioStoreFingerprint } from './source.mjs'

export const ioStoreRecipe = 'cue4parse-iostore-v1'
export const ioStoreFormat = 'unreal-iostore'

export async function readIoStoreCache(root, hash, sourceName, signal) {
  const output = await checkedPath(root, join(root, hash + '-' + ioStoreRecipe))
  if (!output) return null
  try {
    const [manifest, summary, dependencies] = await Promise.all(['manifest', 'conversion-report', 'dependencies']
      .map(name => readPackageDocument(output, name)))
    const entries = manifest?.data?.entries
    const source = manifest?.data?.source
    const report = summary?.data
    if (!dependencies?.data || source?.sha256 !== hash || manifest.data.version !== 1 || manifest.data.recipe !== ioStoreRecipe ||
        source.format !== ioStoreFormat || !Array.isArray(source.files) || ioStoreFingerprint(source.files) !== hash ||
        report?.method !== ioStoreMethod || report.converterVersion !== cue4parseVersion ||
        !Array.isArray(entries) || entries.length > 10_000 || report.total !== entries.length) throw new Error('Invalid cache metadata')
    const extracted = entries.filter(entry => entry.status === 'extracted')
    if (extracted.length !== report.extracted || report.skipped !== entries.length - extracted.length ||
        report.status !== (extracted.length ? 'completed' : 'no-compatible-inputs') ||
        report.counts?.extracted !== report.extracted || report.counts?.skipped !== report.skipped ||
        entries.some(entry => !['extracted', 'skipped'].includes(entry.status)) ||
        extracted.some(entry => !entry.artifact?.path || entry.artifact.status !== 'extracted') ||
        !await verifyExports(output, extracted.map(entry => ({ exports: [entry.artifact] })), signal)) {
      throw new Error('Invalid cached exports')
    }
    return { ...report, output, sourceName, reused: true,
      ...(!report.extracted && { entries: entries.slice(0, 500) }) }
  } catch {
    signal?.throwIfAborted()
    throw new IndexInputError('Кеш импорта Unreal IoStore повреждён.')
  }
}
