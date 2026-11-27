import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactHash, ExportArtifacts, exportFolders } from '../../conversion/artifacts.mjs'
import { publishUnrealArtifacts } from '../../conversion/unreal/editor.mjs'
import { unrealBridgeVersion } from '../../engines/unreal/bridge/project.mjs'
import { prepareUnrealExports } from '../../engines/unreal/bridge/run.mjs'
import { locateUnrealBridge } from '../../engines/unreal/bridge/selection.mjs'
import { inside } from '../../files/asset-files.mjs'
import { IndexInputError } from '../../index/index-errors.mjs'
import { unrealSource } from './source.mjs'

async function managedDirectory(source, directory) {
  const protectedRoot = source.projectRoot ?? source.root
  const check = path => {
    if (inside(protectedRoot, path)) throw new IndexInputError('Папка экспорта находится внутри исходного проекта или Content.')
  }
  check(directory)
  // Resolve the existing parent before creating missing directories, including junctions.
  check(await existingDirectory(directory))
  await mkdir(directory, { recursive: true })
  const canonical = await realpath(directory)
  check(canonical)
  return canonical
}

async function existingDirectory(directory) {
  try {
    return await realpath(directory)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = join(directory, '..')
    if (parent === directory) throw error
    return existingDirectory(parent)
  }
}

async function buildExport(workspace, bridge, source, signal) {
  const output = join(workspace, 'export')
  await mkdir(output)
  await Promise.all(exportFolders.map(folder => mkdir(join(output, folder))))
  const store = new ExportArtifacts(output, signal)
  const entries = []
  const dependencies = []
  let converted = 0
  for (const target of bridge.targets) {
    const result = bridge.results.get(target.id)
    const artifacts = await publishUnrealArtifacts(target.id, result, bridge, store, signal)
    converted += artifacts.filter(file => file.status === 'converted').length
    const files = []
    for (const file of target.files) {
      const sha256 = await artifactHash(join(workspace, 'Content', file.path), signal)
      files.push({ ...file, sha256 })
    }
    entries.push({ ...target, files, artifacts, issue: result.issue })
    dependencies.push({ id: target.id, packageName: target.packageName, references: result.dependencies,
      blockedDependencies: result.blockedDependencies })
  }
  const manifest = { version: 1, source: { type: source.type, name: source.name, association: source.association },
    method: 'unreal-editor', bridgeVersion: unrealBridgeVersion, license: null, entries }
  const report = { ...bridge.summary, staged: entries.length, converted, issues: bridge.issues,
    limits: ['material-graph-not-translated', 'standalone-skeleton-metadata-only', 'glb-preview-unavailable'] }
  if (!converted) return { ...report, status: 'failed',
    failures: entries.map(({ sourcePath, issue, artifacts }) => ({ sourcePath, issue, artifacts })) }
  const reports = { manifest, dependencies, 'conversion-report': report }
  await Promise.all(Object.entries(reports).map(([name, data]) =>
    writeFile(join(output, name + '.json'), JSON.stringify(data, null, 2) + '\n', { signal, flag: 'wx' })))
  return { ...report, output }
}

export async function exportUnrealWithEditor(input, { directory, unrealVersion, signal }) {
  const source = await unrealSource(input)
  if (source.type !== 'uproject' && source.type !== 'content') {
    throw new IndexInputError('Для экспорта выберите .uproject или папку Content.')
  }
  const selection = await locateUnrealBridge(source, unrealVersion)
  if (!selection.editor) return selection
  const root = await managedDirectory(source, join(directory, 'unreal-editor-v1'))
  const workspace = await mkdtemp(join(root, '.stage-'))
  try {
    const bridge = await prepareUnrealExports({ workspace, source, selection, signal })
    if (bridge.summary.status !== 'completed') return { ...bridge.summary, issues: bridge.issues }
    const result = await buildExport(workspace, bridge, source, signal)
    if (!result.output) return result
    signal?.throwIfAborted()
    const destination = join(root, randomUUID())
    await rename(result.output, destination)
    return { ...result, output: destination, sourceName: source.name }
  } finally {
    await rm(workspace, { force: true, recursive: true, maxRetries: 3 })
  }
}
