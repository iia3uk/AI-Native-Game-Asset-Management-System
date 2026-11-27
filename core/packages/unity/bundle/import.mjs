import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactHash, ExportArtifacts, exportFolders } from '../../../conversion/artifacts.mjs'
import { saveBundleAudio } from '../../../conversion/unity/bundle-audio.mjs'
import { saveBundleMesh } from '../../../conversion/unity/bundle-mesh.mjs'
import { saveBundleTexture } from '../../../conversion/unity/bundle-texture.mjs'
import { locateBatchBlender } from '../../../engines/blender/batch.mjs'
import { bundleDecoderRevision, bundleResult } from '../../../engines/unity/bundle/protocol.mjs'
import { assetsToolsVersion, locateBundleWorker, runBundleWorker, stageBundle } from '../../../engines/unity/bundle/run.mjs'
import { packageWorkspaceRoot } from '../../workspace.mjs'
import { bundleRecipe, bundleVersion, readBundleCache } from './cache.mjs'
import { bundleDependencies } from './dependencies.mjs'
import { readBundleSource, selectBundlePath } from './source.mjs'

async function saveOutputs(workspace, source, hash, recipe, report, { withFbx, blender, signal, onProgress }) {
  const output = join(workspace, 'publish')
  const results = join(workspace, 'output')
  await mkdir(output)
  await Promise.all(exportFolders.map(folder => mkdir(join(output, folder))))
  const store = new ExportArtifacts(output, signal)
  const deadline = AbortSignal.timeout(5 * 60_000)
  const fbx = withFbx && { blender, deadline, signal: signal ? AbortSignal.any([signal, deadline]) : deadline }
  const assets = []
  const counts = {}
  for (const asset of report.assets) {
    signal?.throwIfAborted()
    let result = asset
    if (asset.file && asset.format === 'glb') result = await saveBundleMesh(asset, results, store, assetsToolsVersion, fbx, signal)
    if (asset.file && asset.format === 'png') result = await saveBundleTexture(asset, results, store, assetsToolsVersion, signal)
    if (asset.file && asset.format === 'wav') result = await saveBundleAudio(asset, results, store, assetsToolsVersion)
    assets.push(result)
    counts[result.status] = (counts[result.status] ?? 0) + 1
    onProgress?.(50 + Math.floor(40 * assets.length / report.assets.length))
  }
  const converted = counts.converted ?? 0
  const summary = { status: converted ? 'completed' : 'no-compatible-inputs', method: 'assetstools-unityfs',
    converterVersion: assetsToolsVersion, format: report.format, unityVersion: report.unityVersion,
    decoderRevision: report.decoderRevision,
    total: assets.length, converted, skipped: assets.length - converted, counts }
  const documents = {
    manifest: { version: bundleVersion, recipe, source: { name: source.name, size: source.file.info.size, sha256: hash, license: null },
      method: summary.method, converterVersion: assetsToolsVersion, decoderRevision: report.decoderRevision, assets },
    dependencies: bundleDependencies(assets),
    'conversion-report': summary,
  }
  await Promise.all(Object.entries(documents).map(([name, payload]) =>
    writeFile(join(output, name + '.json'), JSON.stringify(payload, null, 2) + '\n', { signal, flag: 'wx' })))
  const cacheable = assets.every(asset => asset.status !== 'failed' && !asset.exports?.some(item => item.status === 'failed'))
  return { summary, output, cacheable }
}

export async function processUnityBundle(selected, { directory, inspectOnly = false, withFbx = false, expectedHash,
  signal, onProgress, publish = (result, move) => { move(); return result } }) {
  const source = await readBundleSource(selected, signal)
  if (source.status) return source
  const root = inspectOnly ? await realpath(tmpdir()) : await packageWorkspaceRoot(directory, 'unity-bundle-v' + bundleVersion)
  const workspace = await mkdtemp(join(root, inspectOnly ? 'asset-viewer-bundle-' : '.stage-'))
  try {
    const stageError = await stageBundle(source, workspace, inspectOnly, signal)
    if (stageError) return { status: 'failed', issue: stageError }
    const hash = await artifactHash(join(workspace, 'input.bundle'), signal)
    if (expectedHash && expectedHash !== hash) return { status: 'failed', issue: 'unity-bundle-source-changed' }
    onProgress?.(15)
    const blender = withFbx && !inspectOnly ? await locateBatchBlender() : null
    const recipe = bundleRecipe(withFbx, blender)
    if (!inspectOnly) {
      const cached = await readBundleCache(root, hash, recipe, source.name, signal)
      if (cached) {
        signal?.throwIfAborted()
        return publish(cached, () => {})
      }
    }
    const executable = await locateBundleWorker()
    if (!executable) return { status: 'unavailable', issue: 'unity-bundle-worker-unavailable' }
    const decoded = await runBundleWorker(executable, workspace, signal)
    if (decoded?.status === 'completed' && decoded.decoderRevision !== bundleDecoderRevision) {
      return { status: 'failed', issue: 'unity-bundle-worker-revision' }
    }
    const report = bundleResult(decoded, inspectOnly)
    if (!report) return { status: 'failed', issue: 'unity-bundle-worker-protocol' }
    if (report.status !== 'completed') return report
    if (inspectOnly) return { ...report, hash, total: report.assets.length, assets: report.assets.slice(0, 500) }
    onProgress?.(50)
    const { summary, output, cacheable } = await saveOutputs(workspace, source, hash, recipe, report, { withFbx, blender, signal, onProgress })
    const destination = join(root, cacheable ? hash + '-' + recipe : randomUUID())
    signal?.throwIfAborted()
    try {
      return publish({ ...summary, output: destination, sourceName: source.name, reused: false }, () => renameSync(output, destination))
    } catch (error) {
      if (!cacheable || !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
      const cached = await readBundleCache(root, hash, recipe, source.name, signal)
      if (!cached) throw error
      signal?.throwIfAborted()
      return publish(cached, () => {})
    }
  } finally {
    await rm(workspace, { force: true, recursive: true, maxRetries: 3 })
  }
}

export async function importUnityBundle(path, options) {
  return processUnityBundle(await selectBundlePath(path), options)
}
