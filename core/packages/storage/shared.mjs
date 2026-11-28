import { lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdtemp, rmdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { checkedPath, inside, pathKey } from '../../files/asset-files.mjs'
import { IndexConflictError } from '../../index/index-errors.mjs'

const prefix = 'AssetViewer-Library-'
const namePattern = /^AssetViewer-Library-[a-zA-Z0-9]{6}$/
const changed = () => new IndexConflictError('Общая папка библиотеки перемещена, заменена или недоступна.')

export function sameStorageDirectory(a, b) {
  return Boolean(typeof a?.path === 'string' && typeof b?.path === 'string' &&
    pathKey(a.path) === pathKey(b.path) && a.dev === b.dev && a.ino === b.ino)
}

function currentDirectory(directory) {
  const info = lstatSync(directory.path, { bigint: true })
  return info.isDirectory() && String(info.dev) === directory.dev && String(info.ino) === directory.ino &&
    pathKey(realpathSync(directory.path)) === pathKey(directory.path)
}

export function verifySharedStorage(root) {
  try {
    if (typeof root?.path === 'string' && typeof root.destination?.path === 'string' &&
        isAbsolute(root.path) && isAbsolute(root.destination.path) && namePattern.test(basename(root.path)) &&
        pathKey(dirname(root.path)) === pathKey(root.destination.path) && currentDirectory(root.destination) &&
        currentDirectory(root)) return root.path
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES', 'ELOOP'].includes(error.code)) throw error
  }
  throw changed()
}

export async function openSharedStorage(registry, destination) {
  const existing = registry.at(destination)
  if (existing) {
    verifySharedStorage(existing)
    return existing
  }
  if (!currentDirectory(destination)) throw changed()
  const path = await mkdtemp(join(destination.path, prefix))
  const { dev, ino } = await lstat(path, { bigint: true })
  const root = { path, dev: String(dev), ino: String(ino) }
  try {
    verifySharedStorage({ ...root, destination })
    return registry.register(root, destination)
  } finally {
    const recorded = registry.at(destination)
    if (!sameStorageDirectory(root, recorded)) {
      const remaining = await lstat(path, { bigint: true }).catch(() => null)
      if (remaining?.isDirectory() && remaining.dev === dev && remaining.ino === ino &&
          await checkedPath(destination.path, path)) await rmdir(path).catch(() => {})
    }
  }
}

export function verifySharedPublication(storage, result) {
  const root = verifySharedStorage(storage)
  if (![result.directory, result.source].every(path => path !== root && inside(root, path))) throw changed()
  const parent = dirname(result.directory)
  if (pathKey(realpathSync(parent)) !== pathKey(parent)) throw changed()
  return root
}

export function sharedDirectoryIdentity(root, path) {
  try {
    if (typeof path === 'string' && isAbsolute(path) && pathKey(path) !== pathKey(root) && inside(root, path) &&
        pathKey(realpathSync(path)) === pathKey(path)) {
      const info = lstatSync(path, { bigint: true })
      if (info.isDirectory()) return { path, dev: String(info.dev), ino: String(info.ino) }
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES', 'ELOOP'].includes(error.code)) throw error
  }
  throw changed()
}

export function sharedDirectoryAvailable({ storage, directory }) {
  try {
    return sameStorageDirectory(sharedDirectoryIdentity(verifySharedStorage(storage), directory?.path), directory)
  } catch (error) {
    if (!(error instanceof IndexConflictError)) throw error
    return false
  }
}
