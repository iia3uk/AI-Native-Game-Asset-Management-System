import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { exportFolders } from '../../conversion/artifacts.mjs'
import { checkedPath } from '../../files/asset-files.mjs'
import { sameSource } from '../../files/hash.mjs'
import { IndexConflictError, IndexInputError } from '../../index/index-errors.mjs'
import { packageHashPattern } from '../source.mjs'
import { preparePackageExport, verifyExportDestination } from './plan.mjs'

async function copyVerified(source, file, target, signal) {
  const changed = () => new IndexConflictError('Не удалось подтвердить SHA-256 файла ' + file.path + '.')
  if (!await checkedPath(source, file.absolute)) throw changed()
  const input = await open(file.absolute, 'r')
  try {
    const verified = await input.stat()
    if (!verified.isFile() || !sameSource(verified, file.info) || !await checkedPath(source, file.absolute)) throw changed()
    const hash = createHash('sha256')
    if (verified.size) {
      const digest = new Transform({
        transform(data, encoding, callback) { hash.update(data); callback(null, data) },
      })
      await pipeline(input.createReadStream({ start: 0, end: verified.size - 1, autoClose: false }), digest,
        createWriteStream(target, { flags: 'wx' }), { signal })
    } else await writeFile(target, '', { flag: 'wx', signal })
    const copied = await stat(target)
    if (copied.size !== verified.size || hash.digest('hex') !== file.sha256 ||
        !sameSource(verified, await input.stat()) || !await checkedPath(source, file.absolute)) throw changed()
  } finally {
    await input.close()
  }
}

async function createDirectory(prefix) {
  const path = await mkdtemp(prefix)
  const { dev, ino } = await stat(path)
  return { path, dev, ino }
}

async function removeDirectory(destination, directory) {
  if (!directory) return
  // A replaced destination or child must never turn cleanup into deletion of another tree.
  try {
    await verifyExportDestination(destination)
    await verifyExportDestination(directory)
  } catch { return }
  await rm(directory.path, { recursive: true, force: true, maxRetries: 3 })
}

export async function exportPackageResult(importDirectory, protectedRoots, job, input, { preview, signal, jobSource }) {
  const deadline = AbortSignal.timeout(10 * 60_000)
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline
  if (!preview && (typeof input?.key !== 'string' || !packageHashPattern.test(input.key))) {
    throw new IndexInputError('Составьте план перед экспортом.')
  }
  let prepared
  try {
    const format = job?.result?.report?.packageFormat
    const roots = format === 'unity-project' || format === 'unity-upm' ? [...protectedRoots, jobSource] : protectedRoots
    prepared = await preparePackageExport(importDirectory, roots, job, input, signal)
    if (!prepared || preview) return prepared?.plan ?? null
    if (prepared.plan.key !== input.key) throw new IndexConflictError('План изменился. Проверьте его перед экспортом.')
    return await publish(prepared, signal)
  } catch (error) {
    if (deadline.aborted) throw new IndexConflictError('Истекло время ожидания экспорта.')
    if (error.code === 'ENOSPC') throw new IndexConflictError('Недостаточно свободного места для экспорта.')
    throw error
  }
}

async function publish({ destination, plan, source, files, reports }, signal) {
  await verifyExportDestination(destination)
  const stage = await createDirectory(join(destination.path, '.asset-viewer-export-'))
  let reservation
  let directory
  try {
    if (plan.scope === 'package') {
      for (const folder of exportFolders) await mkdir(join(stage.path, folder))
    }
    for (const file of files) {
      signal.throwIfAborted()
      await verifyExportDestination(stage)
      const target = join(stage.path, file.path)
      await mkdir(dirname(target), { recursive: true })
      if (!await checkedPath(stage.path, dirname(target))) throw new IndexConflictError('Папка экспорта изменилась.')
      await copyVerified(source, file, target, signal)
    }
    await verifyExportDestination(stage)
    for (const [name, report] of Object.entries(reports)) {
      await writeFile(join(stage.path, name + '.json'), report, { flag: 'wx', signal })
    }
    signal.throwIfAborted()
    await verifyExportDestination(destination)
    reservation = await createDirectory(join(destination.path, plan.prefix + '-'))
    await verifyExportDestination(stage)
    await verifyExportDestination(reservation)
    const target = join(reservation.path, plan.scope === 'package' ? 'Package' : 'Asset')
    await rename(stage.path, target)
    directory = target
    return { ...plan, directory }
  } finally {
    if (!directory) {
      await removeDirectory(destination, stage)
      await removeDirectory(destination, reservation)
    }
  }
}
