import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactHash, ExportArtifacts, exportFolders } from '../../conversion/artifacts.mjs'
import { publishPakEntries } from '../../conversion/unreal/pak.mjs'
import { cue4parseVersion, locateUnrealDecoder, runUnrealDecoder, stagePak } from '../../engines/unreal/decoder/run.mjs'
import { pakResult } from '../../engines/unreal/decoder/protocol.mjs'
import { IndexInputError } from '../../index/index-errors.mjs'
import { inspectUnrealFile } from './inspect.mjs'
import { unrealSource } from './source.mjs'

const maxInput = 2 * 1024 ** 3

async function publish(workspace, root, source, result, signal) {
  const output = join(workspace, 'publish')
  await mkdir(output)
  await Promise.all(exportFolders.map(folder => mkdir(join(output, folder))))
  const store = new ExportArtifacts(output, signal)
  const entries = await publishPakEntries(result.entries, join(workspace, 'output'), store, cue4parseVersion, signal)
  const extracted = entries.filter(entry => entry.status === 'extracted').length
  const summary = { status: extracted ? 'completed' : 'no-compatible-inputs', method: 'cue4parse-pak',
    converterVersion: cue4parseVersion, containerVersion: result.version, extracted, total: entries.length,
    skipped: entries.length - extracted, limits: ['unreal-pak-loose-binary-extraction-only', 'unreal-pak-dependency-analysis-pending'] }
  if (!extracted) return { ...summary, entries: entries.slice(0, 500) }
  const sha256 = await artifactHash(join(workspace, 'input.pak'), signal)
  const reports = {
    manifest: { version: 1, source: { name: source.name, size: source.file.info.size, sha256, license: null },
      method: summary.method, converterVersion: summary.converterVersion, entries },
    dependencies: { version: 1, status: 'unavailable', entries: [] },
    'conversion-report': summary,
  }
  await Promise.all(Object.entries(reports).map(([name, data]) =>
    writeFile(join(output, name + '.json'), JSON.stringify(data, null, 2) + '\n', { signal, flag: 'wx' })))
  signal?.throwIfAborted()
  const destination = join(root, randomUUID())
  await rename(output, destination)
  return { ...summary, output: destination, sourceName: source.name }
}

export async function extractUnrealPak(input, { directory, inspectOnly = false, signal }) {
  const source = await unrealSource(input)
  if (source.type !== 'pak') throw new IndexInputError('Для независимой распаковки выберите файл Unreal .pak.')
  if (source.file.info.size > maxInput) return { status: 'failed', issue: 'unreal-pak-size-limit' }
  const header = await inspectUnrealFile(source.root, source, signal)
  if (header.storage !== 'container') return { status: 'failed', issue: header.issue }
  if (header.encryptedIndex) return { status: 'unsupported', issue: 'unreal-pak-encrypted' }
  const executable = await locateUnrealDecoder()
  if (!executable) return { status: 'unavailable', issue: 'unreal-worker-unavailable' }

  const selectedRoot = join(directory, 'unreal-pak-v1')
  if (!inspectOnly) await mkdir(selectedRoot, { recursive: true })
  const root = await realpath(inspectOnly ? tmpdir() : selectedRoot)
  const workspace = await mkdtemp(join(root, inspectOnly ? 'asset-viewer-unreal-' : '.stage-'))
  try {
    const stageError = await stagePak(source, workspace, inspectOnly, signal)
    if (stageError) return { status: 'failed', issue: stageError }
    const result = pakResult(await runUnrealDecoder(executable, workspace, signal), { version: header.version, inspectOnly })
    if (!result) return { status: 'failed', issue: 'unreal-worker-protocol' }
    if (result.status !== 'completed') return result
    if (inspectOnly) return { status: 'completed', method: 'cue4parse-pak', converterVersion: cue4parseVersion,
      containerVersion: result.version, total: result.entries.length, entries: result.entries.slice(0, 500) }
    return await publish(workspace, root, source, result, signal)
  } finally {
    await rm(workspace, { force: true, recursive: true, maxRetries: 3 })
  }
}
