import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { checkedPath } from '../../files/asset-files.mjs'
import { IndexConflictError } from '../../index/index-errors.mjs'
import { readPackageDocument } from '../manifest-page.mjs'
import { verifyPublishedPackage } from './recover.mjs'

const exportSuffix = /^[a-z\d]{6}$/i
const jobIdPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const rejected = error => error instanceof IndexConflictError ||
  ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EBUSY'].includes(error.code)

export async function findReusableExport({ destination, plan, files, reports, processedManifest }, signal) {
  const prefix = plan.prefix + '-'
  const listing = await opendir(destination.path).catch(error => {
    if (!rejected(error)) throw error
    return null
  })
  if (!listing) return null
  let visited = 0
  let candidates = 0
  for await (const entry of listing) {
    signal.throwIfAborted()
    if (++visited > 20_000) break
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || !exportSuffix.test(entry.name.slice(prefix.length))) continue
    if (++candidates > 32) break
    const reuse = await verifyCandidate(join(destination.path, entry.name), destination.path,
      files, reports, processedManifest, signal).catch(error => {
      signal.throwIfAborted()
      if (!rejected(error)) throw error
      return null
    })
    if (reuse) return reuse
  }
  return null
}

async function verifyCandidate(path, root, files, reports, processedManifest, signal) {
  if (!await checkedPath(root, path)) return null
  const { dev, ino } = await stat(path)
  const directory = await checkedPath(path, 'Package')
  if (!directory) return null
  const manifest = await readPackageDocument(directory, 'manifest')
  const jobId = manifest?.data?.export?.jobId
  if (typeof jobId !== 'string' || !jobIdPattern.test(jobId) ||
      manifest.text !== processedManifest(jobId)) return null
  const reservation = { path, dev, ino }
  const published = await verifyPublishedPackage(reservation, files, { ...reports, manifest: manifest.text }, signal)
  return published ? { reservation, jobId, directory: published } : null
}
