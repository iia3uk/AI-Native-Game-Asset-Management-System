import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { exportRecipe, verifyExports } from '../../../conversion/cache.mjs'
import { locateBatchBlender } from '../../../engines/blender/batch.mjs'
import { unrealBridgeVersion } from '../../../engines/unreal/bridge/project.mjs'
import { locateUnrealBridge } from '../../../engines/unreal/bridge/selection.mjs'
import { checkedPath, fileInfo } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'
import { readPackageDocument } from '../../manifest-page.mjs'
import { packageHashPattern } from '../../source.mjs'
import { packageWorkspaceRoot } from '../../workspace.mjs'
import { convertLoosePackages } from './convert.mjs'
import { readUnrealLoose, unrealSourceChanged } from './inspect.mjs'

const method = 'unreal-loose-direct'
const version = 1

async function cachedResult(root, name, hash, source, recipe, signal) {
  const directory = join(root, name)
  const info = await lstat(directory).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return null
  try {
    if (!info.isDirectory() || !await checkedPath(root, directory)) throw new Error('Invalid import directory')
    const [manifest, summary, links] = await Promise.all([
      readPackageDocument(directory, 'manifest'),
      readPackageDocument(directory, 'conversion-report'),
      fileInfo(directory, 'dependencies.json'),
    ])
    const report = summary?.data
    const data = manifest?.data
    if (!links || data?.version !== version || data.source?.format !== source.format || data.source.sha256 !== hash ||
        data.recipe !== recipe || report?.method !== method || report.version !== version ||
        !Number.isSafeInteger(report.written) || !await verifyExports(directory, data.assets, signal)) {
      throw new Error('Invalid cached Unreal outputs')
    }
    return { directory, source: directory, report: { ...report, selectedDirectory: source.selectedDirectory }, reused: true }
  } catch {
    signal?.throwIfAborted()
    throw new IndexInputError('Сохранённый импорт Unreal повреждён.')
  }
}

async function editorRecipe(selection, mode, preferred) {
  if (!selection?.editor) return selection ? [mode, preferred, selection.issue] : null
  const { executable, version } = selection.editor
  const file = await lstat(executable)
  return [mode, preferred, unrealBridgeVersion, executable, version, file.size, file.mtimeMs]
}

export async function stageUnrealLoose(directory, source, job, { signal, onProgress, publish }) {
  const { engineMode = 'engineless', editorVersion, exportFormats = [], sourceKey } = job
  if (!packageHashPattern.test(sourceKey)) throw new IndexInputError('Некорректный SHA-256 ресурсов Unreal.')
  const [selection, blender] = await Promise.all([
    engineMode === 'engineless' ? null : locateUnrealBridge(source, editorVersion || undefined),
    exportFormats.includes('glb') ? locateBatchBlender() : null,
  ])
  const recipe = exportRecipe(exportFormats, blender, await editorRecipe(selection, engineMode, editorVersion))
  const root = await packageWorkspaceRoot(directory, 'unreal-loose-v' + version, { sourceRoot: source.protectedRoot })
  const name = sourceKey + '-' + recipe
  const cached = await cachedResult(root, name, sourceKey, source, recipe, signal)
  if (cached) {
    const records = await readUnrealLoose(source, { signal, onProgress })
    if (records.hash !== sourceKey) throw unrealSourceChanged()
    signal?.throwIfAborted()
    return publish(cached, () => {}, cached.report.written > 0)
  }
  const workspace = await mkdtemp(join(root, '.stage-'))
  try {
    const output = join(workspace, 'output')
    await mkdir(join(output, 'Source', 'Content'), { recursive: true })
    const records = await readUnrealLoose(source, { output, signal, onProgress })
    if (records.hash !== sourceKey) throw unrealSourceChanged()
    const conversion = selection && records.written ?
      await convertLoosePackages({ records, selection, workspace, output, blender, formats: exportFormats, signal, onProgress }) : null
    const counts = Object.create(null)
    for (const asset of records.assets) counts[asset.status] = (counts[asset.status] ?? 0) + 1
    const metadata = { format: source.format, sha256: sourceKey, size: records.size, association: source.association ?? null,
      ...(source.descriptorVersion && { descriptorVersion: source.descriptorVersion }) }
    const manifest = { version, source: metadata, recipe, assets: records.assets }
    const report = { version, method, mode: engineMode, packageFormat: source.format,
      status: records.written ? 'completed' : 'no-compatible-inputs', counts, written: records.written, total: records.assets.length,
      engineVersion: source.association ?? null, ...(conversion ?? { converted: 0 }),
      limitations: ['cooked-unreal-objects-preserved-as-source', 'dependency-resolution-requires-asset-registry', 'material-graphs-not-converted'] }
    await Promise.all(Object.entries({ manifest, dependencies: { version, dependencies: records.dependencies },
      'conversion-report': report }).map(([key, value]) =>
      writeFile(join(output, key + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', signal })))
    const destination = join(root, name)
    signal?.throwIfAborted()
    onProgress?.(95)
    return publish({ directory: destination, source: destination,
      report: { ...report, selectedDirectory: source.selectedDirectory }, reused: false },
      () => renameSync(output, destination), records.written > 0)
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 })
  }
}
