import { open, opendir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { imageFormats, modelFormats, supportFiles } from './formats.mjs'

export const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path
export const portablePath = path => path.split(sep).join('/')

export class ScanChangeError extends Error {}

export function sameFile(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

export function inside(base, target) {
  const path = relative(base, target)
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}

export async function folderPath(path) {
  const value = typeof path === 'string' ? path.trim().replace(/^"(.*)"$/, '$1') : ''
  const localDrive = value => process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value)
  if (!isAbsolute(value) || !localDrive(value)) throw new Error('Укажите полный путь к папке на этом компьютере.')
  const root = await realpath(value)
  if (!localDrive(root)) throw new Error('Выберите папку на локальном диске.')
  if (!(await stat(root)).isDirectory()) throw new Error('Этот путь ведёт к файлу. Выберите папку.')
  return root
}

// A selected root can be canonicalized once. Child aliases are excluded even when they point within that root.
export async function checkedPath(root, subpath) {
  const path = resolve(root, subpath)
  if (!inside(root, path)) return null
  try {
    const actual = await realpath(path)
    return pathKey(actual) === pathKey(path) ? actual : null
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EINVAL'].includes(error.code)) return null
    throw error
  }
}

export async function fileInfo(root, subpath) {
  const path = await checkedPath(root, subpath)
  if (!path) return null
  try {
    const info = await stat(path)
    return info.isFile() ? { path, info } : null
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null
    throw error
  }
}

export async function readBoundedText(root, subpath, limit) {
  const file = await fileInfo(root, subpath)
  if (!file || file.info.size > limit) return null
  const handle = await open(file.path, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > limit || !await checkedPath(root, file.path)) return null
    const buffer = Buffer.alloc(opened.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    return length === opened.size ? buffer.toString('utf8', 0, length) : null
  } finally {
    await handle.close()
  }
}

export function identifyAsset(path) {
  const ext = extname(path).slice(1).toLowerCase()
  const materialDescription = ext === 'json' && /\.material\.json$/i.test(path)
  const kind = modelFormats.has(ext) ? 'model' : imageFormats.has(ext) ? 'image' :
    supportFiles.has(ext) || materialDescription ? 'other' : null
  return kind && { ext, kind }
}

export async function* discoverAssets(root, { strict = false, signal } = {}) {
  const stack = [root]
  while (stack.length) {
    signal?.throwIfAborted()
    const folder = stack.pop()
    if (!await checkedPath(root, folder)) {
      if (strict || folder === root) throw new ScanChangeError('Папка изменилась во время сканирования.')
      continue
    }
    let directory
    try {
      directory = await opendir(folder)
    } catch (error) {
      if (!strict && folder !== root && ['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) continue
      throw error
    }
    for await (const entry of directory) {
      signal?.throwIfAborted()
      const absolute = join(folder, entry.name)
      if (entry.isDirectory()) stack.push(absolute)
      if (!entry.isFile()) continue
      const format = identifyAsset(entry.name)
      if (!format) continue
      const file = await fileInfo(root, absolute)
      if (file) yield { ...format, absolute: file.path, info: file.info, path: portablePath(relative(root, absolute)) }
      else if (strict) throw new ScanChangeError('Файл изменился или стал недоступен во время сканирования.')
    }
  }
}
