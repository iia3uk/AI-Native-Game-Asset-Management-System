import { basename, dirname, isAbsolute, win32 } from 'node:path'
import { fileInfo, folderPath } from '../files/asset-files.mjs'
import { IndexInputError } from '../index/index-errors.mjs'

export const packageHashPattern = /^[0-9a-f]{64}$/

export function validPackageSegment(segment, maximumLength = 180) {
  return segment.length > 0 && segment.length <= maximumLength && !/[\x00-\x1f\x7f\\:*?"<>|]/.test(segment) &&
    !/[. ]$/.test(segment) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:[. ]|$)/i.test(segment) &&
    !/^[^~.]{1,6}~\d+(?:\.|$)/i.test(segment)
}

export async function packageSource(input) {
  const path = typeof input === 'string' ? input.trim().replace(/^"(.*)"$/, '$1') : ''
  if (!isAbsolute(path) || path.length > 4096 || !validPackageSegment(basename(path))) {
    throw new IndexInputError('Укажите полный путь к локальному файлу пакета.')
  }
  const root = await folderPath(dirname(path)).catch(() => null)
  const file = root && await fileInfo(root, basename(path))
  if (!file) throw new IndexInputError('Файл пакета не найден или недоступен.')
  return { root, path: file.path, name: basename(file.path) }
}

export async function scopedPackageSource(root, path) {
  if (typeof root !== 'string' || !isAbsolute(root) || root.length > 4096 ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(root)) ||
      typeof path !== 'string' || path.length > 4096 || isAbsolute(path) || win32.isAbsolute(path) ||
      path.split('/').some(segment => segment === '.' || segment === '..' || !validPackageSegment(segment))) {
    throw new IndexInputError('Укажите путь к пакету внутри выбранной папки.')
  }
  const file = await fileInfo(root, path)
  if (!file) throw new IndexInputError('Пакет больше не доступен в выбранной папке.')
  return { root, path: file.path, name: basename(file.path) }
}

export async function queuedPackageSource(path) {
  // Queue entries already store a canonical path. Resolve it again without accepting a replacement link.
  const root = dirname(path)
  const file = await fileInfo(root, path)
  if (!file) throw new IndexInputError('Исходный пакет больше не доступен. Проанализируйте файл снова.')
  return { root, path: file.path, name: basename(file.path) }
}

export async function watchedPackageSource({ root, path, enabled }) {
  const name = basename(path)
  if (!enabled || isAbsolute(path) || !validPackageSegment(name)) throw new IndexInputError('Недоступный источник автоимпорта.')
  const file = await fileInfo(root, path)
  if (!file) throw new IndexInputError('Архив больше не доступен в наблюдаемой папке.')
  return { root, path: file.path, name }
}
