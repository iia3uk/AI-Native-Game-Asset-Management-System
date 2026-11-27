import { validPackageSegment } from '../source.mjs'
import { invalid } from './policy.mjs'

const decoder = new TextDecoder('utf-8', { fatal: true })

export function segments(path) {
  const parts = path.split('/')
  if (path.length > 1024 || parts.length > 32 || !parts.every(part => validPackageSegment(part))) {
    throw invalid('опасный путь в архиве.')
  }
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
