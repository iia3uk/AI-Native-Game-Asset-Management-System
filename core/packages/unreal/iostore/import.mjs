import { createHash, randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactHash, ExportArtifacts, exportFolders } from '../../../conversion/artifacts.mjs'
import { publishIoStoreCollision } from '../../../conversion/unreal/collision/iostore.mjs'
import { publishIoStoreMaterials } from '../../../conversion/unreal/cooked-material/iostore.mjs'
import { publishIoStoreMeshes } from '../../../conversion/unreal/cooked-mesh/iostore.mjs'
import { ioStoreMethod, publishIoStoreEntries } from '../../../conversion/unreal/iostore.mjs'
import { locateBatchBlender } from '../../../engines/blender/batch.mjs'
import { ioStoreResult } from '../../../engines/unreal/decoder/protocol.mjs'
import { cue4parseVersion, locateUnrealDecoder, runUnrealDecoder, stageUnrealInputs } from '../../../engines/unreal/decoder/run.mjs'
import { packageWorkspaceRoot } from '../../workspace.mjs'
import { ioStoreFormat, ioStoreRecipe, readIoStoreCache } from './cache.mjs'
import { ioStoreFingerprint, ioStoreSource } from './source.mjs'

async function fingerprintFiles(workspace, source, signal) {
  const inputs = []
  for (const { name, stageName, file } of source.files) {
    const stage = join(workspace, stageName)
    const { size } = await stat(stage)
    if (size !== file.info.size) return null
    inputs.push({ name, size, sha256: await artifactHash(stage, signal) })
  }
  return inputs
}

async function saveOutputs(workspace, source, files, result, hash, { recipe, blender, formats, signal }) {
  const output = join(workspace, 'publish')
  await mkdir(output)
  await Promise.all(exportFolders.map(folder => mkdir(join(output, folder))))
  const store = new ExportArtifacts(output, signal)
  const entries = await publishIoStoreEntries(result.entries, join(workspace, 'output'), store, cue4parseVersion, signal)
  const { materials, dependencies, resolve } = await publishIoStoreMaterials(entries, result.entries, { workspace, store, signal })
  const meshes = await publishIoStoreMeshes(entries, result.entries, { workspace, store, blender, formats, signal,
    resolve, dependencies })
  const collision = await publishIoStoreCollision(entries, result.entries, { workspace, store, signal })
  const counts = { extracted: 0, skipped: 0, failed: 0 }
  const extractedTypes = { package: 0, bulk: 0, file: 0, registry: 0 }
  const derivatives = { texture: { converted: 0, skipped: 0, failed: 0 }, audio: { converted: 0, skipped: 0, failed: 0 } }
  for (const entry of entries) {
    counts[entry.status]++
    if (entry.status === 'extracted') extractedTypes[entry.kind]++
    for (const product of entry.exports ?? []) {
      if (Object.hasOwn(derivatives, product.role)) derivatives[product.role][product.status]++
    }
  }
  const { extracted, skipped, failed } = counts
  const summary = { status: extracted ? 'completed' : 'no-compatible-inputs', method: ioStoreMethod,
    converterVersion: cue4parseVersion, containerVersion: result.version, chunks: source.chunks, partitions: source.partitions,
    extracted, skipped: skipped + failed, counts, extractedTypes, total: entries.length,
    textureDecoder: result.textureDecoder, textures: derivatives.texture,
    audioDecoder: result.audioDecoder, audio: derivatives.audio,
    meshDecoder: result.meshDecoder, ...((meshes || collision) && { meshes: { ...meshes, ...(collision && { collision }) } }),
    materialDecoder: result.materialDecoder, ...(materials && { materials }),
    collisionDecoder: result.collisionDecoder,
    limits: ['unreal-iostore-zen-stock-ue5-versioned-packages', 'unreal-iostore-dependency-analysis-partial'] }
  const json = data => JSON.stringify(data, null, 2) + '\n'
  const hashText = text => createHash('sha256').update(text).digest('hex')
  const dependencyText = json({ version: 1, status: dependencies.length ? 'partial' : 'unavailable', entries: dependencies })
  const reportText = json(summary)
  const manifest = { version: 1, recipe, source: { name: source.name, format: ioStoreFormat,
    size: source.size, sha256: hash, files, license: null }, method: ioStoreMethod, converterVersion: cue4parseVersion, entries,
    dependenciesSha256: hashText(dependencyText), reportSha256: hashText(reportText) }
  const reports = { manifest: json(manifest), dependencies: dependencyText, 'conversion-report': reportText }
  await Promise.all(Object.entries(reports).map(([name, data]) =>
    writeFile(join(output, name + '.json'), data, { signal, flag: 'wx' })))
  const cacheable = !failed && !materials?.issue && !meshes?.issue && !collision?.failed &&
    !entries.some(entry => entry.issue === 'unreal-iostore-space-limit' ||
      entry.exports?.some(product => product.status === 'failed' || /-(io|limit)$/.test(product.issue ?? '')))
  return { output, cacheable, report: { ...summary, ...(!extracted && { entries: entries.slice(0, 500) }) } }
}

const failure = issue => ({ status: 'failed', issue })

export async function processIoStore(input, { directory, inspectOnly = false, expectedHash, withFbx = false, signal, onProgress,
  publish = (result, move) => { move(); return result } }) {
  const source = await ioStoreSource(input, signal)
  if (source.issue) return failure(source.issue)
  const executable = inspectOnly ? await locateUnrealDecoder() : null
  if (inspectOnly && !executable) return failure('unreal-worker-unavailable')
  const formats = withFbx ? ['fbx', 'glb'] : ['glb']
  const blender = !inspectOnly && withFbx ? await locateBatchBlender() : null
  const recipe = ioStoreRecipe(formats, blender)
  const root = inspectOnly ? await realpath(tmpdir()) : await packageWorkspaceRoot(directory, 'unreal-iostore-v1')
  const workspace = await mkdtemp(join(root, inspectOnly ? 'asset-viewer-iostore-' : '.stage-'))
  try {
    const stageError = await stageUnrealInputs(source, 'iostore', workspace, inspectOnly, signal)
    if (stageError) return failure(stageError)
    const files = await fingerprintFiles(workspace, source, signal)
    const hash = files && ioStoreFingerprint(files)
    if (!hash || (expectedHash && hash !== expectedHash)) return failure('unreal-iostore-changed')
    onProgress?.(20)
    if (!inspectOnly) {
      const cached = await readIoStoreCache(root, hash, recipe, source.name, signal)
      if (cached) {
        signal?.throwIfAborted()
        return publish(cached, () => {})
      }
    }
    const worker = executable ?? await locateUnrealDecoder()
    if (!worker) return failure('unreal-worker-unavailable')
    const result = ioStoreResult(await runUnrealDecoder(worker, workspace, signal), { ...source, inspectOnly })
    if (!result) return failure('unreal-worker-protocol')
    if (result.status !== 'completed') return result
    if (inspectOnly) return { status: 'completed', method: ioStoreMethod, converterVersion: cue4parseVersion, hash,
      containerVersion: result.version, chunks: source.chunks, partitions: source.partitions, files,
      total: result.entries.length, entries: result.entries.slice(0, 500) }

    onProgress?.(60)
    const { output, report, cacheable } = await saveOutputs(workspace, source, files, result, hash, { recipe, blender, formats, signal })
    const destination = join(root, cacheable ? hash + '-' + recipe : randomUUID())
    onProgress?.(90)
    signal?.throwIfAborted()
    try {
      return publish({ ...report, output: destination, sourceName: source.name, reused: false }, () => renameSync(output, destination))
    } catch (error) {
      if (!cacheable || !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
      const cached = await readIoStoreCache(root, hash, recipe, source.name, signal)
      if (!cached) throw error
      signal?.throwIfAborted()
      return publish(cached, () => {})
    }
  } finally {
    await rm(workspace, { force: true, recursive: true, maxRetries: 3 })
  }
}
