import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { exportRecipe, verifyExports } from '../../../conversion/cache.mjs'
import { zenAudioMethod } from '../../../conversion/unreal/container-audio.mjs'
import { zenMaterialMethod } from '../../../conversion/unreal/cooked-material/iostore.mjs'
import { meshTotalsMatch, validModelStatus } from '../../../conversion/unreal/cooked-mesh/cache.mjs'
import { ioStoreMethod, zenTextureMethod } from '../../../conversion/unreal/iostore.mjs'
import { ioStoreMaterialRevision } from '../../../engines/unreal/decoder/iostore-material-protocol.mjs'
import { ioStoreMeshRevision } from '../../../engines/unreal/decoder/mesh-protocol.mjs'
import { ioStoreAudioRevision, ioStoreTextureRevision } from '../../../engines/unreal/decoder/protocol.mjs'
import { cue4parseVersion } from '../../../engines/unreal/decoder/run.mjs'
import { checkedPath } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'
import { readPackageDocument } from '../../manifest-page.mjs'
import { ioStoreFingerprint } from './source.mjs'

export const ioStoreRecipe = (formats, blender) => exportRecipe(formats, blender,
  [ioStoreMethod, cue4parseVersion, ioStoreTextureRevision, ioStoreAudioRevision, ioStoreMeshRevision, ioStoreMaterialRevision])
export const ioStoreFormat = 'unreal-iostore'

export async function readIoStoreCache(root, hash, recipe, sourceName, signal) {
  const output = await checkedPath(root, join(root, hash + '-' + recipe))
  if (!output) return null
  try {
    const [manifest, summary, dependencies] = await Promise.all(['manifest', 'conversion-report', 'dependencies']
      .map(name => readPackageDocument(output, name)))
    const entries = manifest?.data?.entries
    const source = manifest?.data?.source
    const report = summary?.data
    const hashText = text => createHash('sha256').update(text).digest('hex')
    if (!dependencies?.data || source?.sha256 !== hash || manifest.data.version !== 1 || manifest.data.recipe !== recipe ||
        !summary?.text || hashText(dependencies.text) !== manifest.data.dependenciesSha256 ||
        hashText(summary.text) !== manifest.data.reportSha256 ||
        source.format !== ioStoreFormat || !Array.isArray(source.files) || ioStoreFingerprint(source.files) !== hash ||
        report?.method !== ioStoreMethod || report.converterVersion !== cue4parseVersion ||
        report.textureDecoder !== ioStoreTextureRevision || report.audioDecoder !== ioStoreAudioRevision ||
        report.meshDecoder !== ioStoreMeshRevision || report.materialDecoder !== ioStoreMaterialRevision ||
        !Array.isArray(entries) || entries.length > 10_000 || report.total !== entries.length) throw new Error('Invalid cache metadata')
    const extracted = entries.filter(entry => entry.status === 'extracted')
    const derivatives = extracted.flatMap(entry => entry.exports ?? [])
    if (extracted.length !== report.extracted || report.skipped !== entries.length - extracted.length ||
        report.status !== (extracted.length ? 'completed' : 'no-compatible-inputs') ||
        report.counts?.extracted !== report.extracted || report.counts?.skipped !== report.skipped ||
        entries.some(entry => !['extracted', 'skipped'].includes(entry.status)) ||
        extracted.some(entry => !entry.artifact?.path || entry.artifact.status !== 'extracted') ||
        derivatives.some(product => !['texture', 'audio', 'model', 'model-buffer', 'material'].includes(product.role) ||
          !validModelStatus(product) || (product.status === 'converted' && !product.path)) ||
        !validDerivatives(derivatives, 'texture', ['png'], zenTextureMethod, report.textures) ||
        !validDerivatives(derivatives, 'audio', ['wav', 'ogg'], zenAudioMethod, report.audio) ||
        !validDerivatives(derivatives, 'material', ['json'], zenMaterialMethod,
          report.materials ?? { converted: 0, skipped: 0, failed: 0 }) ||
        !meshTotalsMatch(extracted, derivatives, report.meshes) ||
        !validMissingLods(extracted, report.meshes) ||
        !await verifyExports(output, extracted.map(entry => ({ exports: [entry.artifact, ...(entry.exports ?? [])] })), signal)) {
      throw new Error('Invalid cached exports')
    }
    return { ...report, output, sourceName, reused: true,
      ...(!report.extracted && { entries: entries.slice(0, 500) }) }
  } catch {
    signal?.throwIfAborted()
    throw new IndexInputError('Кеш импорта Unreal IoStore повреждён.')
  }
}

function validMissingLods(entries, meshes) {
  const missing = entries.flatMap(entry => entry.missingLods ?? [])
  return (!meshes || meshes.failed === 0) && missing.length === (meshes?.missingLods ?? 0) &&
    missing.every(level => Number.isInteger(level) && level >= 0 && level <= 7)
}

function validDerivatives(derivatives, role, formats, method, summary) {
  const rows = derivatives.filter(product => product.role === role)
  return !rows.some(product => product.method !== method || !['converted', 'skipped'].includes(product.status) ||
      (product.status === 'converted' && (!product.path || !formats.includes(product.format)))) &&
    rows.filter(product => product.status === 'converted').length === summary?.converted &&
    rows.filter(product => product.status === 'skipped').length === summary?.skipped && summary?.failed === 0
}
