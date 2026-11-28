import { createHash } from 'node:crypto'
import { renameSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { checkedPath, fileInfo, readBoundedText, sameFile } from '../../files/asset-files.mjs'
import { hashFile } from '../../files/hash.mjs'
import { packageWorkspaceRoot } from '../workspace.mjs'
import { readUnityFolder } from './folder/inspect.mjs'
import { unityFolderLayout } from './folder/layout.mjs'
import { readPackage } from './inspect.mjs'
import { hashPattern, invalid, MiB, packageLimits, unityPackageVersion } from './policy.mjs'
import { packageDocuments } from './report.mjs'
import { verifyMaterialOutputs } from './material-outputs.mjs'
import { locateBatchBlender } from '../../engines/blender/batch.mjs'
import { packageExportVersion } from '../../conversion/formats.mjs'
import { exportRecipe, verifyExports } from '../../conversion/cache.mjs'
import { exportPackage } from '../../conversion/batch.mjs'
import { locateUnityBridge, prepareUnityExports, removeUnityProject } from '../../engines/unity/bridge/run.mjs'

const packageDirectory = 'unitypackage-v' + unityPackageVersion

async function reuse(root, key, hash, formats, signal, limits, verifyOriginals) {
  const directory = join(root, key)
  const existing = await lstat(directory).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!existing) return null
  const source = join(directory, 'Source')
  const valid = existing.isDirectory() && await checkedPath(root, source)
  const manifest = valid && await readBoundedText(directory, 'manifest.json', 64 * MiB)
  const report = valid && await readBoundedText(directory, 'conversion-report.json', 64 * 1024)
  if (!manifest || !report || !(await lstat(source)).isDirectory()) throw invalid('сохранённый импорт повреждён.')
  try {
    const metadata = JSON.parse(manifest)
    const recorded = JSON.parse(report)
    if (metadata.source.sha256 !== hash || metadata.version !== unityPackageVersion ||
        recorded.version !== unityPackageVersion || !Number.isSafeInteger(recorded.written) ||
        !await fileInfo(directory, 'dependencies.json')) throw new Error('Invalid import manifest')
    if (!await verifyMaterialOutputs(directory, metadata.assets, recorded.materials?.written ?? 0, limits.dependencyBytes, signal)) {
      throw new Error('Invalid material descriptions')
    }
    if (formats.length && (recorded.export?.version !== packageExportVersion ||
        recorded.export.formats?.join(',') !== formats.join(',') ||
        !await verifyExports(directory, metadata.assets, signal))) throw new Error('Invalid export manifest')
    if (verifyOriginals) await verifySourceOutputs(directory, metadata.assets, signal)
    return { directory, source: formats.length ? directory : source, report: recorded, reused: true }
  } catch {
    signal?.throwIfAborted()
    throw invalid('сохранённый импорт повреждён.')
  }
}

export async function stageUnityPackage(directory, source, hash, {
  signal, onProgress, limits = packageLimits, formats = [], mode = 'engineless', editorVersion = '', publish,
}) {
  signal?.throwIfAborted()
  if (!hashPattern.test(hash)) throw invalid('некорректный SHA-256 пакета.')
  const readSource = source.directory ? readUnityFolder : readPackage
  if (source.directory && mode !== 'engineless' && !editorVersion) {
    editorVersion = (await unityFolderLayout(source.root, signal)).engineVersion ?? ''
  }
  const [blender, editor] = await Promise.all([
    formats.length ? locateBatchBlender() : null,
    mode === 'engineless' ? null : locateUnityBridge(editorVersion),
  ])
  const engine = editor && [mode, editorVersion, editor.identity ?? editor.issue]
  const key = formats.length ? hash + '-' + exportRecipe(formats, blender, engine) : hash
  const recipeDirectory = formats.length ? packageDirectory + '-export-v' + packageExportVersion : packageDirectory
  const root = await packageWorkspaceRoot(directory, recipeDirectory, { sourceRoot: source.directory ? source.root : undefined })
  const cached = await reuse(root, key, hash, formats, signal, limits, source.directory)
  if (cached) {
    if (source.directory) {
      if ((await readSource(source, { signal, onProgress, limits })).hash !== hash) throw stalePackage()
    } else await verifyPackageHash(source, hash, limits, signal)
    signal?.throwIfAborted()
    return publish(cached, () => {})
  }
  const staging = await mkdtemp(join(root, '.stage-'))
  try {
    const records = await readSource(source, { staging, signal, onProgress, limits })
    if (records.hash !== hash) throw stalePackage()
    const output = join(staging, 'output')
    await mkdir(join(output, 'Source'), { recursive: true })
    const createExports = formats.length ? async entries => {
      const project = join(staging, 'unity')
      try {
        const bridge = editor && await prepareUnityExports({ project, output, entries, selection: editor, signal,
          includePackageAssets: source.directory })
        return await exportPackage({ output, scratch: staging, entries, formats, blender, bridge, signal, onProgress })
      } finally {
        if (editor) await removeUnityProject(project)
      }
    } : undefined
    const report = await packageDocuments(records, output, signal, limits, onProgress, createExports, mode)
    const target = join(root, key)
    return publish({ directory: target, source: formats.length ? target : join(target, 'Source'), report, reused: false },
      () => renameSync(output, target))
  } finally {
    await rm(staging, { force: true, recursive: true })
  }
}

const stalePackage = () => invalid('пакет изменился после анализа. Проанализируйте его снова.')

async function verifySourceOutputs(directory, assets, signal) {
  for (const entry of assets) {
    signal?.throwIfAborted()
    for (const [path, hash] of [[entry.output, entry.hash], [entry.metadata, entry.metadataHash]]) {
      if (!path) continue
      const file = path.startsWith('Source/') && await fileInfo(directory, path)
      if (!file || await hashFile(directory, file.path, file.info, signal) !== hash) {
        throw new Error('Invalid source output')
      }
    }
  }
}

async function verifyPackageHash(source, expected, limits, signal) {
  const handle = await open(source.path)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > limits.compressed || !await checkedPath(source.root, source.path)) throw stalePackage()
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      bytes += chunk.length
      if (bytes > opened.size) throw stalePackage()
      hash.update(chunk)
    }
    if (bytes !== opened.size || hash.digest('hex') !== expected || !sameFile(opened, await handle.stat()) ||
        !await checkedPath(source.root, source.path)) throw stalePackage()
  } finally {
    await handle.close()
  }
}
