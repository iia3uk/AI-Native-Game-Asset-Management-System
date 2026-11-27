import { basename, dirname, isAbsolute } from 'node:path'
import { fileInfo, folderPath } from '../../files/asset-files.mjs'
import { invalid } from './policy.mjs'

const decoder = new TextDecoder('utf-8', { fatal: true })

function validSegment(segment) {
  return segment.length > 0 && segment.length <= 180 && !/[\x00-\x1f\x7f\\:*?"<>|]/.test(segment) &&
    !/[. ]$/.test(segment) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:[. ]|$)/i.test(segment) &&
    !/^[^~.]{1,6}~\d+(?:\.|$)/i.test(segment)
}

export function segments(path) {
  const parts = path.split('/')
  if (path.length > 1024 || parts.length > 32 || !parts.every(validSegment)) throw invalid('опасный путь в архиве.')
  return parts
}

export function logicalPath(bytes) {
  const value = decoder.decode(bytes).split(/\r?\n/, 1)[0]
  const parts = segments(value)
  if (parts[0] !== 'Assets' && parts[0] !== 'Packages') throw invalid('pathname должен начинаться с Assets или Packages.')
  return value
}

export function checkPathTree(tree, path, directory) {
  const parts = path.split('/')
  for (const [index, name] of parts.entries()) {
    const key = name.normalize('NFC').toLowerCase()
    const last = index === parts.length - 1
    const existing = tree.get(key)
    if (existing && (existing.name !== name || !existing.children || (last && !directory))) {
      throw invalid('конфликт имён в структуре проекта.')
    }
    if (!existing) tree.set(key, { name, children: (!last || directory) ? new Map() : null })
    tree = tree.get(key).children
  }
}

export async function packageSource(input) {
  const path = typeof input === 'string' ? input.trim().replace(/^"(.*)"$/, '$1') : ''
  if (!isAbsolute(path) || path.length > 4096 || !validSegment(basename(path))) {
    throw invalid('укажите полный путь к локальному файлу.')
  }
  const root = await folderPath(dirname(path)).catch(() => null)
  const file = root && await fileInfo(root, basename(path))
  if (!file) throw invalid('файл не найден или недоступен.')
  return { root, path: file.path, name: basename(file.path) }
}
