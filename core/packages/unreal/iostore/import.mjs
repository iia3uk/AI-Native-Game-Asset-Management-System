import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactHash, ExportArtifacts, exportFolders } from '../../../conversion/artifacts.mjs'
import { ioStoreMethod, publishIoStoreEntries } from '../../../conversion/unreal/iostore.mjs'
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

async function saveOutputs(workspace, source, files, result, hash, signal) {
  const output = join(workspace, 'publish')
  await mkdir(output)
  await Promise.all(exportFolders.map(folder => mkdir(join(output, folder))))
  const store = new ExportArtifacts(output, signal)
  const entries = await publishIoStoreEntries(result.entries, join(workspace, 'output'), store, cue4parseVersion, signal)
  const counts = { extracted: 0, skipped: 0, failed: 0 }
  const extractedTypes = { package: 0, bulk: 0, file: 0, registry: 0 }
  for (const entry of entries) {
    counts[entry.status]++
    if (entry.status === 'extracted') extractedTypes[entry.kind]++
  }
  const { extracted, skipped, failed } = counts
  const summary = { status: extracted ? 'completed' : 'no-compatible-inputs', method: ioStoreMethod,
    converterVersion: cue4parseVersion, containerVersion: result.version, chunks: source.chunks, partitions: source.partitions,
    extracted, skipped: skipped + failed, counts, extractedTypes, total: entries.length,
    limits: ['unreal-iostore-native-chunks-only', 'unreal-iostore-dependency-analysis-pending'] }
  const reports = {
    manifest: { version: 1, recipe: ioStoreRecipe, source: { name: source.name, format: ioStoreFormat,
      size: source.size, sha256: hash, files, license: null }, method: ioStoreMethod, converterVersion: cue4parseVersion, entries },
    dependencies: { version: 1, status: 'unavailable', entries: [] },
    'conversion-report': summary,
  }
  await Promise.all(Object.entries(reports).map(([name, data]) =>
    writeFile(join(output, name + '.json'), JSON.stringify(data, null, 2) + '\n', { signal, flag: 'wx' })))
  const cacheable = !failed && !entries.some(entry => entry.issue === 'unreal-iostore-space-limit')
  return { output, cacheable, report: { ...summary, ...(!extracted && { entries: entries.slice(0, 500) }) } }
}

const failure = issue => ({ status: 'failed', issue })

export async function processIoStore(input, { directory, inspectOnly = false, expectedHash, signal, onProgress,
  publish = (result, move) => { move(); return result } }) {
  const source = await ioStoreSource(input, signal)
  if (source.issue) return failure(source.issue)
  const executable = inspectOnly ? await locateUnrealDecoder() : null
  if (inspectOnly && !executable) return failure('unreal-worker-unavailable')
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
      const cached = await readIoStoreCache(root, hash, source.name, signal)
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
    const { output, report, cacheable } = await saveOutputs(workspace, source, files, result, hash, signal)
    const destination = join(root, cacheable ? hash + '-' + ioStoreRecipe : randomUUID())
    onProgress?.(90)
    signal?.throwIfAborted()
    try {
      return publish({ ...report, output: destination, sourceName: source.name, reused: false }, () => renameSync(output, destination))
    } catch (error) {
      if (!cacheable || !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
      const cached = await readIoStoreCache(root, hash, source.name, signal)
      if (!cached) throw error
      signal?.throwIfAborted()
      return publish(cached, () => {})
    }
  } finally {
    await rm(workspace, { force: true, recursive: true, maxRetries: 3 })
  }
}
