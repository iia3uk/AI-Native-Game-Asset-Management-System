import { randomUUID } from 'node:crypto'
import { lstat, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { checkedPath, fileInfo, pathKey, readBoundedText } from '../../files/asset-files.mjs'
import { unityDataFormats } from '../../files/formats.mjs'
import { sameSource } from '../../files/hash.mjs'
import { packageHashPattern } from '../source.mjs'
import { relativeSourcePath } from './files.mjs'

const markerName = 'retired-sources.json'
const markerLimit = 32 * 1024 ** 2

function nativePath(path) {
  if (!relativeSourcePath(path) || !path.startsWith('Source/')) return false
  const type = posix.extname(path).slice(1).toLowerCase()
  return type === 'uasset' || unityDataFormats.has(type)
}

async function recordedCopies(directory) {
  const raw = await readBoundedText(directory, markerName, markerLimit)
  if (!raw) return new Map()
  try {
    const { version, files } = JSON.parse(raw)
    if (version === 1 && Array.isArray(files)) {
      return new Map(files.filter(entry => Array.isArray(entry) && entry.length === 2 &&
        nativePath(entry[0]) && typeof entry[1] === 'string' && packageHashPattern.test(entry[1])))
    }
  } catch { /* A malformed marker cannot authorize an omission. */ }
  return new Map()
}

export async function availablePackageAssets(directory, assets, signal) {
  if (!Array.isArray(assets)) return assets
  const recorded = await recordedCopies(directory)
  if (!recorded.size) return assets
  let available = assets
  for (const [index, row] of assets.entries()) {
    signal?.throwIfAborted()
    if (!row.output || recorded.get(row.output) !== row.hash) continue
    const existing = await lstat(join(directory, row.output)).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing) continue
    if (available === assets) available = [...assets]
    available[index] = { ...row, output: null, sourceRetired: true }
  }
  return available
}

async function saveCopies(directory, recorded, currentDirectory, signal) {
  const temporary = join(directory, '.retired-' + randomUUID() + '.tmp')
  const data = JSON.stringify({ version: 1, files: [...recorded] }) + '\n'
  if (Buffer.byteLength(data) > markerLimit) throw new Error('Retirement marker is too large')
  try {
    if (!await currentDirectory()) throw new Error('Managed import directory changed')
    await writeFile(temporary, data, { flag: 'wx', signal })
    signal.throwIfAborted()
    if (!await currentDirectory() || !await checkedPath(directory, temporary)) throw new Error('Managed import directory changed')
    await rename(temporary, join(directory, markerName))
  } finally {
    if (await currentDirectory() && await checkedPath(directory, temporary)) await unlink(temporary)
  }
}

async function unchanged(directory, file) {
  const current = await fileInfo(directory, file.path)
  return current && sameSource(current.info, file.info)
}

export async function retireNativeCopies(imports, moved, signal) {
  const keyed = new Map()
  for (const entry of moved) {
    const copy = entry.nativeCopy
    if (!copy || !nativePath(copy.relative) || !packageHashPattern.test(copy.sha256) ||
        entry.backups.length < 2 || entry.backups[0] !== copy.file ||
        pathKey(copy.file.path) !== pathKey(join(entry.output, copy.relative))) continue
    keyed.set(pathKey(copy.file.path), entry)
  }
  const candidates = [...keyed.values()]
  const result = { retired: 0, retiredBytes: 0, skippedRetirement: candidates.length }
  if (!candidates.length) return result
  const root = await realpath(imports)
  for (const [directory, entries] of Map.groupBy(candidates, entry => entry.output)) {
    try {
      signal.throwIfAborted()
      if (directory === root || !await checkedPath(root, directory)) continue
      const initial = await lstat(directory)
      if (!initial.isDirectory()) continue
      const currentDirectory = async () => {
        if (!await checkedPath(root, directory)) return false
        const actual = await lstat(directory)
        return actual.isDirectory() && actual.dev === initial.dev && actual.ino === initial.ino
      }
      const recorded = await recordedCopies(directory)
      for (const { nativeCopy: { relative, sha256 } } of entries) recorded.set(relative, sha256)
      await saveCopies(directory, recorded, currentDirectory, signal)
      for (const { nativeCopy: { file }, backups } of entries) {
        signal.throwIfAborted()
        if (!await currentDirectory()) break
        let protectedByExports = true
        for (const backup of backups.slice(1)) {
          if (await unchanged(directory, backup)) continue
          protectedByExports = false
          break
        }
        if (!protectedByExports || !await unchanged(directory, file)) continue
        try { await unlink(file.path) } catch { continue }
        result.retired++
        result.retiredBytes += file.info.size
        result.skippedRetirement--
      }
    } catch {
      signal.throwIfAborted()
    }
  }
  return result
}
