import { mkdir, open, rename, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { readBoundedText } from '../../files/asset-files.mjs'
import { unityDataFormats as unityData } from '../../files/formats.mjs'
import { invalid, unityPackageVersion } from './policy.mjs'

function extractReferences(text) {
  const refs = []
  for (const [mapping] of text.matchAll(/\{[^{}\r\n]{1,240}\}/g)) {
    const fileID = mapping.match(/[{,][ \t]*fileID:[ \t]*(-?\d{1,20})(?=[ \t]*[,}])/)?.[1]
    if (!fileID || fileID === '0') continue
    const guid = mapping.match(/[,][ \t]*guid:[ \t]*([0-9a-f]{32})(?=[ \t]*[,}])/i)?.[1]?.toLowerCase()
    refs.push({ guid: guid ?? null, fileID })
  }
  return refs
}

export async function packageDocuments(packageInfo, output, signal, limits, onProgress, createExports) {
  const descriptions = []
  const byId = new Map()
  let textBudget = limits.dependencyBytes
  let remainingReferences = limits.dependencies
  for (const asset of packageInfo.assets) {
    signal?.throwIfAborted()
    const { payload, meta, preview, hasMeta, hasPreview, ...fields } = asset
    const entry = { ...fields, method: 'unitypackage-direct', hash: payload?.hash ?? null, license: null,
      output: null, metadata: null, metadataHash: null, preview: null, previewHash: null, fileIDs: [], issues: [] }
    const allowed = !['unsupported', 'failed'].includes(entry.status)
    const path = join(output, 'Source', asset.sourcePath)
    if (allowed && (payload || meta)) await mkdir(dirname(path), { recursive: true })
    if (allowed && asset.kind === 'folder') await mkdir(path, { recursive: true })
    if (allowed && payload) {
      await rename(payload.temp, path)
      entry.output = 'Source/' + asset.sourcePath
    }
    let metadataText = ''
    if (allowed && meta) {
      await rename(meta.temp, path + '.meta')
      entry.metadata = 'Source/' + asset.sourcePath + '.meta'
      entry.metadataHash = meta.hash
      if (meta.size <= textBudget) {
        metadataText = await readBoundedText(output, path + '.meta', limits.metadata) ?? ''
        textBudget -= meta.size
      } else entry.issues.push('metadata-analysis-limit')
    } else if (!hasMeta) entry.issues.push('metadata-missing')
    if (allowed && preview && await validPackagePreview(preview.temp)) {
      const target = 'Previews/' + asset.id + '.png'
      await mkdir(join(output, 'Previews'), { recursive: true })
      await rename(preview.temp, join(output, target))
      entry.preview = target
      entry.previewHash = preview.hash
    } else if (allowed && hasPreview) entry.issues.push('preview-invalid')
    if (entry.status === 'unsupported') entry.issues.push('file-type-excluded')
    if (entry.status === 'failed') entry.issues.push('asset-payload-missing')

    let text = ''
    const unityText = payload && unityData.has(extname(asset.sourcePath).slice(1).toLowerCase())
    if (allowed && unityText) {
      if (payload.size <= Math.min(limits.metadata, textBudget)) {
        text = await readBoundedText(output, path, limits.metadata) ?? ''
        textBudget -= payload.size
        if (!/^%YAML[ \t]/.test(text)) {
          text = ''
          entry.status = 'requires-engine'
          entry.issues.push('unity-binary-or-unrecognized-yaml')
        }
      } else {
        entry.status = 'requires-engine'
        entry.issues.push('unity-text-analysis-limit')
      }
    }
    entry.fileIDs = [...new Set([...text.matchAll(/^--- !u!\d+ &(-?\d{1,20})\b/gm)].map(match => match[1]))]
    entry.references = extractReferences(metadataText).concat(extractReferences(text))
    if (entry.references.length > remainingReferences) throw invalid('превышено число ссылок Unity.')
    remainingReferences -= entry.references.length
    byId.set(entry.id, entry)
    descriptions.push(entry)
  }
  onProgress?.(75)
  const dependencies = []
  const fileIDs = new Map(descriptions.map(entry => [entry.id, new Set(entry.fileIDs)]))
  for (const entry of descriptions) {
    const unique = new Set()
    for (const ref of entry.references) {
      const guid = ref.guid ?? entry.id
      const key = guid + ':' + ref.fileID
      if (unique.has(key)) continue
      unique.add(key)
      const target = byId.get(guid)
      let status = 'missing'
      if (/^0{16}[ef]0{15}$/.test(guid)) status = 'builtin'
      else if (target?.status === 'unsupported') status = 'excluded'
      else if (target && target.status !== 'failed') {
        status = fileIDs.get(guid).has(ref.fileID) ? 'resolved' : 'guid-resolved'
      }
      if (['missing', 'excluded'].includes(status) && !entry.issues.includes('missing-dependencies')) {
        entry.issues.push('missing-dependencies')
      }
      dependencies.push({ source: entry.id, target: guid, fileID: ref.fileID, status, path: target?.sourcePath ?? null })
    }
    if (entry.status === 'extracted' && entry.issues.includes('missing-dependencies')) entry.status = 'missing-dependencies'
    delete entry.references
  }
  signal?.throwIfAborted()
  const exports = await createExports?.(descriptions)
  const source = { format: packageInfo.format, sha256: packageInfo.hash, size: packageInfo.size }
  const manifest = { version: unityPackageVersion, source, engineVersion: null, assets: descriptions }
  const counts = Object.create(null)
  for (const { status } of descriptions) counts[status] = (counts[status] ?? 0) + 1
  const written = descriptions.filter(entry => entry.output || entry.metadata).length
  const report = { version: unityPackageVersion, mode: 'engineless', method: 'unitypackage-direct', counts, written,
    converted: exports?.modelsConverted ?? 0, ...(exports && { export: exports }),
    limitations: ['native-unity-decoding-unavailable', ...(!exports ? ['no-generated-model-export'] : []),
      'material-graphs-not-converted'] }
  for (const [name, document] of Object.entries({ manifest, dependencies: { version: unityPackageVersion, dependencies },
    'conversion-report': report })) {
    await writeFile(join(output, name + '.json'), JSON.stringify(document, null, 2) + '\n', { flag: 'wx', signal })
  }
  onProgress?.(95)
  return report
}

async function validPackagePreview(path) {
  const handle = await open(path)
  try {
    const bytes = Buffer.alloc(33)
    return (await handle.read(bytes)).bytesRead === bytes.length &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(8) === 13 &&
      [bytes.readUInt32BE(16), bytes.readUInt32BE(20)].every(edge => edge > 0 && edge <= 4096)
  } finally {
    await handle.close()
  }
}
