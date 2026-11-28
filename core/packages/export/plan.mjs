import { createHash } from 'node:crypto'
import { realpath, stat, statfs } from 'node:fs/promises'
import { exportFolders } from '../../conversion/artifacts.mjs'
import { checkedPath, fileInfo, folderPath, inside } from '../../files/asset-files.mjs'
import { IndexConflictError, IndexInputError } from '../../index/index-errors.mjs'
import { readPackageDocument, readPackageResult } from '../manifest-page.mjs'
import { packageHashPattern, validPackageSegment } from '../source.mjs'
import { isUnrealLoose } from '../unreal/loose/source.mjs'
import { selectPackageAssets } from './dependencies.mjs'
import { processedAssets } from './processed.mjs'

const exportLimit = 9 * 1024 ** 3
const spaceReserve = 64 * 1024 ** 2
const documents = ['manifest', 'dependencies', 'conversion-report']
const dataFolders = new Set(['Source', ...exportFolders])
const changed = () => new IndexConflictError('Файлы или отчёт импорта изменились. Проверьте результат импорта.')
const json = data => JSON.stringify(data, null, 2) + '\n'

export async function exportDestination(input, protectedRoots) {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f]/.test(input)) {
    throw new IndexInputError('Выберите существующую папку для экспорта.')
  }
  const path = await folderPath(input).catch(() => null)
  if (!path) throw new IndexInputError('Выберите существующую папку для экспорта.')
  const canonicalRoots = await Promise.all(protectedRoots.filter(Boolean).map(root => realpath(root).catch(() => root)))
  if (canonicalRoots.some(root => inside(root, path))) {
    throw new IndexInputError('Выберите папку вне подключённых библиотек и каталогов данных приложения.')
  }
  const { dev, ino } = await stat(path)
  return { path, dev, ino }
}

export async function verifyExportDestination({ path, dev, ino }) {
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory() || info.dev !== dev || info.ino !== ino || !await checkedPath(path, path)) {
    throw new IndexConflictError('Папка назначения изменилась. Составьте план экспорта снова.')
  }
}

function assetFiles(asset) {
  return [
    asset.output && { path: asset.output, sha256: asset.hash, size: asset.size },
    asset.metadata && { path: asset.metadata, sha256: asset.metadataHash },
    asset.preview && { path: asset.preview, sha256: asset.previewHash },
    asset.materialDescription, asset.artifact, ...(asset.exports ?? []),
  ].filter(file => file?.path)
}

async function collectFiles(directory, rows, byteLimit, signal) {
  const files = new Map()
  let bytes = 0
  for (const row of rows) for (const { path, sha256, size } of assetFiles(row)) {
    signal.throwIfAborted()
    const segments = typeof path === 'string' && path.length <= 4096 ? path.split('/') : []
    if (segments.length < 2 || !dataFolders.has(segments[0]) ||
        segments.some(segment => !validPackageSegment(segment, 255)) ||
        typeof sha256 !== 'string' || !packageHashPattern.test(sha256)) throw changed()
    const key = path.normalize('NFC').toLowerCase()
    const prior = files.get(key)
    if (prior) {
      if (prior.path !== path || prior.sha256 !== sha256 || (size !== undefined && size !== prior.info.size)) throw changed()
      continue
    }
    const found = await fileInfo(directory, path)
    if (!found || (size !== undefined && found.info.size !== size)) throw changed()
    bytes += found.info.size
    if (bytes > byteLimit || files.size >= 150_000) throw new IndexInputError('Превышен лимит размера экспорта.')
    files.set(key, { path, absolute: found.path, info: found.info, sha256 })
  }
  return { files: [...files.values()], bytes }
}

function selectDocuments(managed, selection, dependencies, conversion, files) {
  const entries = managed.pak ? 'entries' : 'assets'
  return {
    manifest: json({ ...managed.manifest.data, [entries]: selection.assets, selection: { asset: selection.selected.id } }),
    dependencies: json({ version: dependencies.data.version, status: dependencies.data.status, entries: selection.records }),
    'conversion-report': json({
      version: 1, method: 'package-asset-export', originalMethod: conversion.data.method,
      counts: Object.fromEntries(Object.entries(Object.groupBy(selection.assets, row => row.status))
        .map(([status, rows]) => [status, rows.length])),
      files: files.length, unresolved: selection.unresolved,
      limitations: conversion.data.limitations ?? conversion.data.limits ?? [],
    }),
  }
}

export async function preparePackageExport(importDirectory, protectedRoots, job, input, signal) {
  signal.throwIfAborted()
  const managed = await readPackageResult(importDirectory, job)
  if (!managed) return null
  const ordinal = input?.asset
  const processedOnly = input?.processedOnly ?? false
  if (typeof processedOnly !== 'boolean' || processedOnly && ordinal !== undefined) {
    throw new IndexInputError('Экспорт обработанных файлов доступен для всего пакета.')
  }
  if (ordinal !== undefined && (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= managed.assets.length)) {
    throw new IndexInputError('Выберите ресурс из отчёта импорта.')
  }
  const destination = await exportDestination(input?.destination, [...protectedRoots, managed.root])
  const [dependencies, conversion] = await Promise.all([
    readPackageDocument(managed.directory, 'dependencies'), readPackageDocument(managed.directory, 'conversion-report'),
  ])
  if (!dependencies?.data || !conversion?.data) throw changed()
  const selected = managed.assets[ordinal]
  if (selected && !assetFiles(selected).length) throw new IndexInputError('Для ресурса нет файлов для экспорта.')
  const selection = selected && await selectPackageAssets(managed, dependencies.data, selected, signal)
  const byteLimit = isUnrealLoose(conversion.data.packageFormat) ? 20 * 1024 ** 3 + spaceReserve : exportLimit
  const assets = selection?.assets ?? (processedOnly ? processedAssets(managed.assets) : managed.assets)
  const { files, bytes: assetBytes } = await collectFiles(managed.directory, assets, byteLimit, signal)
  if (processedOnly && !files.length) throw new IndexConflictError('Нет готовых файлов для экспорта.')
  const reports = selection ? selectDocuments(managed, selection, dependencies, conversion, files) :
    { manifest: processedOnly ? json({ ...managed.manifest.data, [managed.pak ? 'entries' : 'assets']: assets,
      export: { processedOnly, jobId: job.id } }) : managed.manifest.text,
    dependencies: dependencies.text, 'conversion-report': conversion.text }
  const bytes = assetBytes + Object.values(reports).reduce((total, report) => total + Buffer.byteLength(report), 0)
  if (bytes > byteLimit) throw new IndexInputError('Превышен лимит размера экспорта.')
  await verifyExportDestination(destination)
  const { bavail, bsize } = await statfs(destination.path, { bigint: true })
  if (bavail * bsize < BigInt(bytes + spaceReserve)) throw new IndexConflictError('Недостаточно свободного места для экспорта.')
  const hash = createHash('sha256').update(JSON.stringify([job.id, ordinal, destination, files.map(({ path, sha256, info }) =>
    [path, sha256, info.size])]))
  for (const document of [managed.manifest, dependencies, conversion]) hash.update(document.text).update('\0')
  for (const report of Object.values(reports)) hash.update(report).update('\0')
  const packageName = job.packageName.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 56)
  const prefix = 'AssetViewer-' + (packageName || 'Package')
  const plan = { key: hash.digest('hex'), destination: destination.path, prefix, scope: selected ? 'asset' : 'package',
    ...(processedOnly && { processedOnly }), assets: assets.length, files: files.length + documents.length, bytes,
    unresolved: selection?.unresolved ?? null, dependencyStatus: dependencies.data.status,
    paths: [...documents.map(name => name + '.json'), ...files.slice(0, 100 - documents.length).map(file => file.path)] }
  return { plan, destination, source: managed.directory, reports, files }
}
