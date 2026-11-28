import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { collisionTotalsMatch } from '../../../conversion/unreal/collision/cache.mjs'
import { cookedAudioMethod } from '../../../conversion/unreal/container-audio.mjs'
import { cookedMaterialPreviewsMatch, isCookedPreviewMethod } from '../../../conversion/unreal/cooked-material/cache.mjs'
import { cookedMaterialMethod, cookedMaterialRevision } from '../../../conversion/unreal/cooked-material/publish.mjs'
import { cookedMaterialPreviewRevision } from '../../../conversion/unreal/cooked-material/texture-previews.mjs'
import { meshTotalsMatch, validModelStatus } from '../../../conversion/unreal/cooked-mesh/cache.mjs'
import { skeletonRoles, skeletonTotalsMatch } from '../../../conversion/unreal/skeleton/cache.mjs'
import { exportRecipe, verifyExports } from '../../../conversion/cache.mjs'
import { cookedCollisionRevision } from '../../../engines/unreal/collision/cooked.mjs'
import { cookedAudioRevision } from '../../../engines/unreal/decoder/audio-protocol.mjs'
import { cue4parseVersion } from '../../../engines/unreal/decoder/run.mjs'
import { looseMeshRevision } from '../../../engines/unreal/decoder/mesh-protocol.mjs'
import { pakTextureRevision } from '../../../engines/unreal/decoder/protocol.mjs'
import { ue4SkeletonRevision } from '../../../engines/unreal/skeleton/ue4.mjs'
import { checkedPath, readBoundedText } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'

export const pakRecipe = (formats, blender) => exportRecipe(formats, blender,
  [2, cue4parseVersion, pakTextureRevision, cookedMaterialRevision, looseMeshRevision, cookedAudioRevision,
    cookedCollisionRevision, ue4SkeletonRevision, cookedMaterialPreviewRevision])
export const pakMethod = 'cue4parse-pak'
const roles = new Set(['texture', 'material', 'model', 'skeletal-model', 'model-buffer', 'audio', 'collision-shapes',
  'collision-preview', 'preview-texture', ...skeletonRoles])

export async function readPakCache(root, hash, recipe, sourceName, signal) {
  const output = join(root, hash + '-' + recipe)
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
        !summaryText || createHash('sha256').update(summaryText).digest('hex') !== manifest.reportSha256 ||
        manifest.source?.sha256 !== hash || manifest.recipe !== recipe || manifest.version !== 1 ||
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
        (extracted.some(entry => entry.format === 'uasset') &&
          (report.textureDecoder !== pakTextureRevision || report.audioDecoder !== cookedAudioRevision)) ||
        !totalsMatch('texture', report.textures) || !totalsMatch('material', report.materials) || !totalsMatch('audio', report.audio) ||
        !cookedMaterialPreviewsMatch(extracted, report.materials, cookedMaterialMethod) ||
        !meshTotalsMatch(extracted, derivatives, report.meshes) ||
        !collisionTotalsMatch(extracted, report.meshes?.collision) ||
        !skeletonTotalsMatch(extracted, report.unrealSkeletons, JSON.parse(dependencies).entries) ||
        derivatives.some(file => !roles.has(file.role) ||
          !validModelStatus(file) ||
          (file.role === 'preview-texture' && !isCookedPreviewMethod(file.method)) ||
          (file.role === 'audio' && (file.method !== cookedAudioMethod ||
            file.status === 'converted' && !['wav', 'ogg'].includes(file.format))) ||
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
