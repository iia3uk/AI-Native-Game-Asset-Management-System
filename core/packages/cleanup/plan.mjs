import { isAbsolute } from 'node:path'
import { realpath } from 'node:fs/promises'
import { fileInfo, inside } from '../../files/asset-files.mjs'
import { sameSource } from '../../files/hash.mjs'
import { readPackageResult } from '../manifest-page.mjs'
import { cleanupCandidates, cleanupEngine } from './candidates.mjs'
import { verifiedCleanupFile } from './files.mjs'

export async function planPackageCleanup({ imports, protectedRoots, job, source, signal }) {
  if (job?.type !== 'package-import' || job.status !== 'completed' || !isAbsolute(source ?? '') ||
      job.result?.report?.status === 'no-compatible-inputs') return null
  const result = await readPackageResult(imports, job)
  if (!result) return null
  const manifest = result.manifest.data
  const format = job.result.report?.packageFormat ?? manifest.source.format
  const engine = cleanupEngine(format)
  if (!engine) return null
  const protectedPaths = await Promise.all([...protectedRoots, result.root].map(path => realpath(path).catch(() => path)))
  const files = []
  for await (const candidate of cleanupCandidates(format, source, manifest, result.assets,
    job.result.report?.selectedDirectory, signal)) {
    const original = await verifiedCleanupFile(candidate.root, candidate.path, candidate, signal)
    if (!original || protectedPaths.some(path => inside(path, original.path))) continue
    const backups = []
    for (const backup of candidate.backups) {
      const file = await verifiedCleanupFile(result.directory, backup.path, backup, signal)
      if (!file) break
      backups.push(file)
    }
    if (backups.length === candidate.backups.length) files.push({ original, root: candidate.root, backups, output: result.directory })
  }
  return { engine, source, output: result.directory, files,
    bytes: files.reduce((sum, file) => sum + file.original.info.size, 0) }
}

async function stillCurrent(root, file) {
  const current = await fileInfo(root, file.path)
  return current && sameSource(current.info, file.info)
}

export async function trashPackageSources(plan, trash, signal) {
  let moved = 0
  let bytes = 0
  for (const { original, root, backups, output } of plan.files) {
    signal.throwIfAborted()
    try {
      let available = true
      for (const backup of backups) {
        signal.throwIfAborted()
        if (await stillCurrent(output, backup)) continue
        available = false
        break
      }
      if (!available || !await stillCurrent(root, original)) continue
      await trash(original.path)
      moved++
      bytes += original.info.size
    } catch {
      signal.throwIfAborted()
    }
  }
  return { moved, skipped: plan.files.length - moved, bytes }
}
