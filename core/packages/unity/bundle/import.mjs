import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { artifactHash, ExportArtifacts, exportFolders } from '../../../conversion/artifacts.mjs'
import { saveBundleTexture } from '../../../conversion/unity/bundle-texture.mjs'
import { bundleResult } from '../../../engines/unity/bundle/protocol.mjs'
import { assetsToolsVersion, inputLimit, locateBundleWorker, runBundleWorker, stageBundle } from '../../../engines/unity/bundle/run.mjs'
import { fileInfo, folderPath, sameFile } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'

const signature = Buffer.from('UnityFS\0')

async function readSource(input, signal) {
  const path = typeof input === 'string' ? input.trim().replace(/^"(.*)"$/, '$1') : ''
  if (path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) {
    throw new IndexInputError('Укажите полный путь к локальному Unity AssetBundle.')
  }
  const root = await folderPath(dirname(path)).catch(() => null)
  const file = root && await fileInfo(root, basename(path))
  if (!file) throw new IndexInputError('Выберите доступный файл Unity AssetBundle.')
  if (file.info.size < 48 || file.info.size > inputLimit) return { status: 'failed', issue: 'unity-bundle-input-size' }
  signal?.throwIfAborted()
  const handle = await open(file.path, 'r')
  try {
    if (!sameFile(await handle.stat(), file.info)) return { status: 'failed', issue: 'unity-bundle-source-changed' }
    const bytes = Buffer.alloc(signature.length)
    if ((await handle.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length || !bytes.equals(signature)) {
      return { status: 'failed', issue: 'unity-bundle-signature' }
    }
  } finally {
    await handle.close()
  }
  return { root, file, name: basename(file.path) }
}

async function publish(workspace, root, source, report, signal) {
  const output = join(workspace, 'publish')
  const results = join(workspace, 'output')
  await mkdir(output)
  await Promise.all(exportFolders.map(folder => mkdir(join(output, folder))))
  const store = new ExportArtifacts(output, signal)
  const assets = []
  for (const asset of report.assets) {
    signal?.throwIfAborted()
    assets.push(asset.file ? await saveBundleTexture(asset, results, store, assetsToolsVersion, signal) : asset)
  }
  const converted = assets.filter(asset => asset.status === 'converted').length
  const summary = { status: converted ? 'completed' : 'no-compatible-inputs', method: 'assetstools-unityfs-rgba32',
    converterVersion: assetsToolsVersion, format: report.format, unityVersion: report.unityVersion,
    total: assets.length, converted, skipped: assets.length - converted }
  if (!converted) return { ...summary, assets: assets.slice(0, 500) }
  const sha256 = await artifactHash(join(workspace, 'input.bundle'), signal)
  const reports = {
    manifest: { version: 1, source: { name: source.name, size: source.file.info.size, sha256, license: null },
      method: summary.method, converterVersion: assetsToolsVersion, assets },
    dependencies: { version: 1, status: 'unavailable', entries: [] },
    'conversion-report': summary,
  }
  await Promise.all(Object.entries(reports).map(([name, payload]) =>
    writeFile(join(output, name + '.json'), JSON.stringify(payload, null, 2) + '\n', { signal, flag: 'wx' })))
  signal?.throwIfAborted()
  const destination = join(root, randomUUID())
  await rename(output, destination)
  return { ...summary, output: destination, sourceName: source.name }
}

export async function importUnityBundle(path, { directory, inspectOnly = false, signal }) {
  const source = await readSource(path, signal)
  if (source.status) return source
  const executable = await locateBundleWorker()
  if (!executable) return { status: 'unavailable', issue: 'unity-bundle-worker-unavailable' }
  const selectedRoot = join(directory, 'unity-bundle-v1')
  if (!inspectOnly) await mkdir(selectedRoot, { recursive: true })
  const root = await realpath(inspectOnly ? tmpdir() : selectedRoot)
  const workspace = await mkdtemp(join(root, inspectOnly ? 'asset-viewer-bundle-' : '.stage-'))
  try {
    const stageError = await stageBundle(source, workspace, inspectOnly, signal)
    if (stageError) return { status: 'failed', issue: stageError }
    const report = bundleResult(await runBundleWorker(executable, workspace, signal), inspectOnly)
    if (!report) return { status: 'failed', issue: 'unity-bundle-worker-protocol' }
    if (report.status !== 'completed') return report
    if (inspectOnly) return { ...report, total: report.assets.length, assets: report.assets.slice(0, 500) }
    return await publish(workspace, root, source, report, signal)
  } finally {
    await rm(workspace, { force: true, recursive: true, maxRetries: 3 })
  }
}
