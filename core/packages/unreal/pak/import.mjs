import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactHash, ExportArtifacts, exportFolders } from '../../../conversion/artifacts.mjs'
import { publishPakEntries } from '../../../conversion/unreal/pak.mjs'
import { pakResult } from '../../../engines/unreal/decoder/protocol.mjs'
import { cue4parseVersion, locateUnrealDecoder, runUnrealDecoder, stagePak } from '../../../engines/unreal/decoder/run.mjs'
import { fileInfo } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'
import { packageWorkspaceRoot } from '../../workspace.mjs'
import { inspectUnrealFile } from '../inspect.mjs'
import { unrealSource } from '../source.mjs'
import { pakMethod, pakRecipe, readPakCache } from './cache.mjs'

const maxInput = 2 * 1024 ** 3

async function saveOutputs(workspace, source, result, hash, signal) {
  const output = join(workspace, 'publish')
  await mkdir(output)
  await Promise.all(exportFolders.map(folder => mkdir(join(output, folder))))
  const store = new ExportArtifacts(output, signal)
  const entries = await publishPakEntries(result.entries, join(workspace, 'output'), store, cue4parseVersion, signal)
  const extracted = entries.filter(entry => entry.status === 'extracted').length
  const skipped = entries.length - extracted
  const failed = entries.filter(entry => entry.status === 'failed').length
  const summary = { status: extracted ? 'completed' : 'no-compatible-inputs', method: pakMethod,
    converterVersion: cue4parseVersion, containerVersion: result.version, extracted, skipped, total: entries.length,
    counts: { extracted, skipped: skipped - failed, ...(failed && { failed }) },
    limits: ['unreal-pak-loose-binary-extraction-only', 'unreal-pak-dependency-analysis-pending'] }
  const reports = {
    manifest: { version: 1, recipe: pakRecipe, source: { name: source.name, size: source.file.info.size, sha256: hash, license: null },
      method: summary.method, converterVersion: summary.converterVersion, entries },
    dependencies: { version: 1, status: 'unavailable', entries: [] },
    'conversion-report': summary,
  }
  await Promise.all(Object.entries(reports).map(([name, data]) =>
    writeFile(join(output, name + '.json'), JSON.stringify(data, null, 2) + '\n', { signal, flag: 'wx' })))
  return { output, cacheable: !failed, report: { ...summary, ...(!extracted && { entries: entries.slice(0, 500) }) } }
}

export async function processUnrealPak({ root: sourceRoot, path, name }, { directory, inspectOnly = false, expectedHash,
  signal, onProgress, publish = (result, move) => { move(); return result } }) {
  const file = await fileInfo(sourceRoot, path)
  if (!file) return { status: 'failed', issue: 'unreal-pak-changed' }
  if (file.info.size > maxInput) return { status: 'failed', issue: 'unreal-pak-size-limit' }
  const source = { root: sourceRoot, file, name, type: 'pak' }
  const header = await inspectUnrealFile(sourceRoot, source, signal)
  if (header.storage !== 'container') return { status: 'failed', issue: header.issue }
  if (header.encryptedIndex) return { status: 'unsupported', issue: 'unreal-pak-encrypted' }
  const executable = inspectOnly ? await locateUnrealDecoder() : null
  if (inspectOnly && !executable) return { status: 'unavailable', issue: 'unreal-worker-unavailable' }

  const root = inspectOnly ? await realpath(tmpdir()) : await packageWorkspaceRoot(directory, 'unreal-pak-v1')
  const workspace = await mkdtemp(join(root, inspectOnly ? 'asset-viewer-unreal-' : '.stage-'))
  try {
    const stageError = await stagePak(source, workspace, inspectOnly, signal)
    if (stageError) return { status: 'failed', issue: stageError }
    const hash = await artifactHash(join(workspace, 'input.pak'), signal)
    if (expectedHash && hash !== expectedHash) return { status: 'failed', issue: 'unreal-pak-changed' }
    onProgress?.(20)
    if (!inspectOnly) {
      const cached = await readPakCache(root, hash, name, signal)
      if (cached) {
        signal?.throwIfAborted()
        return publish(cached, () => {})
      }
    }
    const worker = executable ?? await locateUnrealDecoder()
    if (!worker) return { status: 'unavailable', issue: 'unreal-worker-unavailable' }
    const result = pakResult(await runUnrealDecoder(worker, workspace, signal), { version: header.version, inspectOnly })
    if (!result) return { status: 'failed', issue: 'unreal-worker-protocol' }
    if (result.status !== 'completed') return result
    if (inspectOnly) return { status: 'completed', method: pakMethod, converterVersion: cue4parseVersion, hash,
      containerVersion: result.version, total: result.entries.length, entries: result.entries.slice(0, 500) }

    onProgress?.(60)
    const { output, report, cacheable } = await saveOutputs(workspace, source, result, hash, signal)
    const destination = join(root, cacheable ? hash + '-' + pakRecipe : randomUUID())
    onProgress?.(90)
    signal?.throwIfAborted()
    try {
      return publish({ ...report, output: destination, sourceName: name, reused: false }, () => renameSync(output, destination))
    } catch (error) {
      if (!cacheable || !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
      const cached = await readPakCache(root, hash, name, signal)
      if (!cached) throw error
      signal?.throwIfAborted()
      return publish(cached, () => {})
    }
  } finally {
    await rm(workspace, { force: true, recursive: true, maxRetries: 3 })
  }
}

export async function extractUnrealPak(input, options) {
  const source = await unrealSource(input)
  if (source.type !== 'pak') throw new IndexInputError('Для независимой распаковки выберите файл Unreal .pak.')
  return processUnrealPak({ root: source.root, path: source.file.path, name: source.name }, options)
}
