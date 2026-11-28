import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { exportRecipe, verifyExports } from '../../../conversion/cache.mjs'
import { publishSourceSoundCues } from '../../../conversion/unreal/source-audio/publish.mjs'
import { prepareSourceMaterials, publishSourceMaterials } from '../../../conversion/unreal/source-material/publish.mjs'
import { recoverUnrealMedia } from '../../../conversion/unreal/source-media/extract.mjs'
import { publishSourceMeshes } from '../../../conversion/unreal/source-mesh/publish.mjs'
import { publishTexturedViewerModels } from '../../../conversion/unreal/viewer/bind-materials.mjs'
import { publishActorXAnimations } from '../../../conversion/unreal/viewer/actorx/publish.mjs'
import { createViewerDerivatives } from '../../../conversion/unreal/viewer/derivatives.mjs'
import { locateBatchBlender } from '../../../engines/blender/batch.mjs'
import { unrealBridgeVersion } from '../../../engines/unreal/bridge/project.mjs'
import { locateUnrealBridge } from '../../../engines/unreal/bridge/selection.mjs'
import { sourceSoundCueRevision } from '../../../engines/unreal/source-audio/cues.mjs'
import { sourceMeshRevision } from '../../../engines/unreal/source-mesh/run.mjs'
import { sourceMaterialRevision } from '../../../engines/unreal/source-material/properties.mjs'
import { locateUnrealViewer, unrealViewerRevision } from '../../../engines/unreal/viewer/run.mjs'
import { checkedPath, fileInfo } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'
import { readPackageDocument } from '../../manifest-page.mjs'
import { availablePackageAssets } from '../../cleanup/retired.mjs'
import { packageHashPattern } from '../../source.mjs'
import { packageWorkspaceRoot } from '../../workspace.mjs'
import { convertLoosePackages } from './convert.mjs'
import { readUnrealLoose, unrealSourceChanged } from './inspect.mjs'
import { decodeLooseWithViewer, recoverLooseViewerMaterials } from './viewer.mjs'

const method = 'unreal-loose-direct'
const version = 2

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
        !Number.isSafeInteger(report.written) ||
        !await verifyExports(directory, await availablePackageAssets(directory, data.assets, signal), signal)) {
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
  const [selection, viewer] = await Promise.all([
    engineMode === 'engineless' ? null : locateUnrealBridge(source, editorVersion || undefined),
    locateUnrealViewer(),
  ])
  const blender = exportFormats.length ? await locateBatchBlender() : null
  const editor = await editorRecipe(selection, engineMode, editorVersion)
  const engineRecipe = [editor, ['unreal-source-mesh', sourceMeshRevision], ['unreal-source-material', sourceMaterialRevision],
    ['unreal-sound-cue', sourceSoundCueRevision],
    viewer && ['ue-viewer', unrealViewerRevision, ...viewer.identity]]
  const recipe = exportRecipe(exportFormats, blender, engineRecipe)
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
    const decoded = viewer && records.written ?
      await decodeLooseWithViewer({ viewer, records, output, workspace, source, signal }) : null
    const sourceMeshes = records.written ? await publishSourceMeshes({ records, output, workspace, source, store: decoded?.store, signal }) : null
    const unrealSourceMeshes = sourceMeshes?.summary
    const unrealViewer = decoded?.summary ?? (exportFormats.length > 0 && !selection?.editor && !unrealSourceMeshes?.gltf ?
      { status: 'unavailable', issue: 'unreal-viewer-unavailable' } : undefined)
    if (decoded) onProgress?.(65)
    const conversion = selection && records.written ?
      await convertLoosePackages({ records, selection, workspace, output, blender, formats: exportFormats, signal,
        onProgress: progress => onProgress?.((decoded ? 65 : 60) + Math.floor((progress - 60) * 0.4)) }) : null
    const media = await recoverUnrealMedia(records, { output, workspace, signal,
      onProgress: progress => onProgress?.(79 + Math.floor(progress * 0.04)) })
    const soundCues = await publishSourceSoundCues({ records, output, workspace, source, signal })
    const packedMapCache = new Map()
    const sourceMaterialInput = sourceMeshes && await prepareSourceMaterials({ records, output, workspace, signal,
      store: sourceMeshes.store, resolve: sourceMeshes.resolveMaterial })
    const materialByPath = decoded ? await recoverLooseViewerMaterials({ decoded, viewer, records, output, workspace, signal,
      cache: packedMapCache, applySourceMaps: sourceMaterialInput?.applySourceMaps }) : null
    const sourceMaterials = sourceMeshes && await publishSourceMaterials({ records, signal, sourceMaterials: sourceMaterialInput,
      store: sourceMeshes.store, cache: packedMapCache })
    if (sourceMeshes?.models.length) {
      await publishTexturedViewerModels({ ...sourceMeshes, counts: unrealSourceMeshes, records, output, workspace, signal,
        method: 'unreal-source-mesh-material-binding',
        materialByPath: (path, asset) => {
          const target = sourceMeshes.resolveMaterial(path, asset)
          return target ? materialByPath?.(target.sourcePath) ?? sourceMaterials.material(target) : null
        } })
    }
    if (decoded?.animations?.length) {
      decoded.summary.animationBinding = await publishActorXAnimations({ ...decoded, output, workspace, records, signal })
    }
    const derivativeStages = [decoded, sourceMeshes].filter(stage => stage?.models.length)
    onProgress?.(85)
    if (exportFormats.length) {
      for (const [index, stage] of derivativeStages.entries()) {
        stage.summary.derivatives = await createViewerDerivatives({ ...stage, workspace, output, blender, formats: exportFormats, signal,
          onProgress: progress => onProgress?.(85 + Math.floor((index + progress / 100) * 9 / derivativeStages.length)) })
      }
    }
    const counts = Object.create(null)
    for (const asset of records.assets) counts[asset.status] = (counts[asset.status] ?? 0) + 1
    const metadata = { format: source.format, sha256: sourceKey, size: records.size, association: source.association ?? null,
      ...(source.descriptorVersion && { descriptorVersion: source.descriptorVersion }) }
    const manifest = { version, source: metadata, recipe, assets: records.assets }
    const report = { version, method, mode: engineMode, packageFormat: source.format,
      status: records.written ? 'completed' : 'no-compatible-inputs', counts, written: records.written, total: records.assets.length,
      engineVersion: source.association ?? null, ...conversion, converted: counts.converted ?? 0, media,
      ...(unrealViewer && { unrealViewer }),
      ...(unrealSourceMeshes && { unrealSourceMeshes }),
      ...(sourceMaterials && { unrealSourceMaterials: sourceMaterials.summary }),
      ...(soundCues.graphs || soundCues.incomplete || soundCues.issue ? { soundCues } : {}),
      limitations: ['unsupported-cooked-unreal-objects-preserved-as-source', 'dependency-resolution-requires-asset-registry',
        'material-graphs-not-converted', 'source-collision-limited-to-supported-simple-ue4-shapes'] }
    await Promise.all(Object.entries({ manifest, dependencies: { version, dependencies: records.dependencies },
      'conversion-report': report }).map(([key, value]) =>
      writeFile(join(output, key + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', signal })))
    const partial = unrealViewer?.status === 'partial' || unrealSourceMeshes?.issue || sourceMaterials?.summary.issue || soundCues.issue
    const destination = join(root, partial ? name + '-' + randomUUID() : name)
    signal?.throwIfAborted()
    onProgress?.(95)
    return publish({ directory: destination, source: destination,
      report: { ...report, selectedDirectory: source.selectedDirectory }, reused: false },
      () => renameSync(output, destination), records.written > 0)
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 })
  }
}
