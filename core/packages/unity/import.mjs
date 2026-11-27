import { createHash } from 'node:crypto'
import { renameSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { checkedPath, fileInfo, readBoundedText, sameFile } from '../../files/asset-files.mjs'
import { readPackage } from './inspect.mjs'
import { hashPattern, invalid, MiB, packageLimits, unityPackageVersion } from './policy.mjs'
import { packageDocuments } from './report.mjs'
import { locateBatchBlender } from '../../engines/blender/batch.mjs'
import { packageExportVersion } from '../../conversion/formats.mjs'
import { exportRecipe, verifyExports } from '../../conversion/cache.mjs'
import { exportPackage } from '../../conversion/batch.mjs'

const packageDirectory = 'unitypackage-v' + unityPackageVersion

async function importRoot(directory, exportEnabled) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const root = await realpath(directory)
  const version = join(root, exportEnabled ? packageDirectory + '-export-v' + packageExportVersion : packageDirectory)
  await mkdir(version, { mode: 0o700, recursive: true })
  if (!await checkedPath(root, version)) throw invalid('каталог импорта недоступен.')
  return version
}

async function reuse(root, key, hash, formats, signal) {
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
    if (formats.length && (recorded.export?.version !== packageExportVersion ||
        recorded.export.formats?.join(',') !== formats.join(',') ||
        !await verifyExports(directory, metadata.assets, signal))) throw new Error('Invalid export manifest')
    return { directory, source: formats.length ? directory : source, report: recorded, reused: true }
  } catch {
    signal?.throwIfAborted()
    throw invalid('сохранённый импорт повреждён.')
  }
}

export async function stageUnityPackage(directory, source, hash, { signal, onProgress, limits = packageLimits, formats = [], publish }) {
  signal?.throwIfAborted()
  if (!hashPattern.test(hash)) throw invalid('некорректный SHA-256 пакета.')
  const blender = formats.length ? await locateBatchBlender() : null
  const key = formats.length ? hash + '-' + exportRecipe(formats, blender) : hash
  const root = await importRoot(directory, formats.length)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.stage-[a-zA-Z0-9]{6}$/.test(entry.name)) continue
    const target = join(root, entry.name)
    if (await checkedPath(root, target) && Date.now() - (await lstat(target)).mtimeMs > 60 * 60 * 1000) {
      await rm(target, { recursive: true, force: true })
    }
  }
  const cached = await reuse(root, key, hash, formats, signal)
  if (cached) {
    await verifyPackageHash(source, hash, limits, signal)
    signal?.throwIfAborted()
    return publish(cached, () => {})
  }
  const staging = await mkdtemp(join(root, '.stage-'))
  try {
    const records = await readPackage(source, { staging, signal, onProgress, limits })
    if (records.hash !== hash) throw invalid('пакет изменился после анализа. Проанализируйте его снова.')
    const output = join(staging, 'output')
    await mkdir(join(output, 'Source'), { recursive: true })
    const createExports = formats.length
      ? entries => exportPackage({ output, scratch: staging, entries, formats, blender, signal, onProgress }) : undefined
    const report = await packageDocuments(records, output, signal, limits, onProgress, createExports)
    const target = join(root, key)
    return publish({ directory: target, source: formats.length ? target : join(target, 'Source'), report, reused: false },
      () => renameSync(output, target))
  } finally {
    await rm(staging, { force: true, recursive: true })
  }
}

async function verifyPackageHash(source, expected, limits, signal) {
  const handle = await open(source.path)
  try {
    const opened = await handle.stat()
    const changed = () => invalid('пакет изменился после анализа. Проанализируйте его снова.')
    if (!opened.isFile() || opened.size > limits.compressed || !await checkedPath(source.root, source.path)) throw changed()
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      bytes += chunk.length
      if (bytes > opened.size) throw changed()
      hash.update(chunk)
    }
    if (bytes !== opened.size || hash.digest('hex') !== expected || !sameFile(opened, await handle.stat()) ||
        !await checkedPath(source.root, source.path)) throw changed()
  } finally {
    await handle.close()
  }
}
