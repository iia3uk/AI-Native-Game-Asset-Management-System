import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { cookedMaterialRevision } from '../../../conversion/unreal/cooked-material/publish.mjs'
import { verifyExports } from '../../../conversion/cache.mjs'
import { cue4parseVersion } from '../../../engines/unreal/decoder/run.mjs'
import { pakTextureRevision } from '../../../engines/unreal/decoder/protocol.mjs'
import { checkedPath, readBoundedText } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'

export const pakRecipe = createHash('sha256').update(JSON.stringify([1, cue4parseVersion, pakTextureRevision, cookedMaterialRevision])).digest('hex').slice(0, 24)
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
      readBoundedText(output, 'dependencies.json', 32 * 1024 ** 2),
    ])
    const manifest = JSON.parse(manifestText)
    const report = JSON.parse(summaryText)
    const entries = manifest?.entries
    if (!dependencies || createHash('sha256').update(dependencies).digest('hex') !== manifest.dependenciesSha256 ||
        manifest.source?.sha256 !== hash || manifest.recipe !== pakRecipe || manifest.version !== 1 ||
        report?.method !== pakMethod || report.converterVersion !== cue4parseVersion ||
        !Array.isArray(entries) || entries.length > 10_000 || report.total !== entries.length) throw new Error('Invalid cache metadata')
    const extracted = entries.filter(entry => entry.status === 'extracted')
    const derivatives = entries.flatMap(entry => entry.exports ?? [])
    const totalsMatch = (role, summary) => ['converted', 'skipped'].every(status =>
      derivatives.filter(file => file.role === role && file.status === status).length === (summary?.[status] ?? 0))
    if (extracted.length !== report.extracted || report.skipped !== entries.length - extracted.length ||
        report.counts?.extracted !== report.extracted || report.counts?.skipped !== report.skipped ||
        report.status !== (extracted.length ? 'completed' : 'no-compatible-inputs') ||
        extracted.some(entry => !entry.artifact?.path) ||
        (extracted.some(entry => entry.format === 'uasset') && report.textureDecoder !== pakTextureRevision) ||
        !totalsMatch('texture', report.textures) || !totalsMatch('material', report.materials) ||
        derivatives.some(file => !['texture', 'material'].includes(file.role) || !['converted', 'skipped'].includes(file.status) ||
          (file.status === 'converted' && !file.path)) ||
        !await verifyExports(output, extracted.map(entry => ({ exports: [entry.artifact, ...(entry.exports ?? [])] })), signal)) {
      throw new Error('Invalid cached exports')
    }
    return { ...report, output, sourceName, reused: true,
      ...(!report.extracted && { entries: entries.slice(0, 500) }) }
  } catch {
    signal?.throwIfAborted()
    throw new IndexInputError('Кеш импорта Unreal Pak повреждён.')
  }
}
