import { lstat, opendir } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { checkedPath, fileInfo, folderPath, readBoundedText } from '../../files/asset-files.mjs'
import { IndexInputError } from '../../index/index-errors.mjs'

const fileTypes = new Set(['uproject', 'uplugin', 'uasset', 'umap', 'uexp', 'ubulk', 'uptnl', 'pak', 'utoc', 'ucas'])

export const unrealFileType = path => basename(path).toLowerCase() === 'assetregistry.bin'
  ? 'asset-registry' : extname(path).slice(1).toLowerCase()

export const isUnrealSourceFile = name => unrealFileType(name) === 'asset-registry' || fileTypes.has(unrealFileType(name))

async function readDescriptor(root, path) {
  const raw = await readBoundedText(root, path, 1024 ** 2)
  try {
    const descriptor = raw && JSON.parse(raw.replace(/^\uFEFF/, ''))
    return Number.isInteger(descriptor?.FileVersion) && descriptor.FileVersion > 0 ? descriptor : null
  } catch { return null }
}

export async function unrealSource(input) {
  const path = typeof input === 'string' ? input.trim().replace(/^"(.*)"$/, '$1') : ''
  if (path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) {
    throw new IndexInputError('Укажите полный путь к локальным ресурсам Unreal.')
  }
  const info = await lstat(path).catch(() => null)
  if (info?.isDirectory()) {
    const root = await folderPath(path).catch(() => null)
    if (root && basename(root).toLowerCase() === 'content') {
      return { type: 'content', root, name: basename(root), association: null }
    }
  }
  const root = await folderPath(dirname(path)).catch(() => null)
  const file = root && await fileInfo(root, basename(path))
  if (!file || !isUnrealSourceFile(file.path)) throw new IndexInputError('Выберите проект .uproject, папку Content или файл Unreal.')
  const type = unrealFileType(file.path)
  const source = { type, root, name: basename(file.path), file }
  if (type !== 'uproject' && type !== 'uplugin') return source
  const descriptor = await readDescriptor(root, file.path)
  if (!descriptor) throw new IndexInputError('Описание проекта или плагина Unreal повреждено.')
  source.descriptorVersion = descriptor.FileVersion
  if (type === 'uplugin') return source
  source.association = typeof descriptor.EngineAssociation === 'string' ? descriptor.EngineAssociation.trim().slice(0, 100) : null
  const content = await checkedPath(root, 'Content')
  if (!content || !(await lstat(content)).isDirectory()) throw new IndexInputError('Папка Content проекта Unreal недоступна.')
  return { ...source, root: content, projectRoot: root }
}

export async function* unrealContentFiles(root, signal) {
  const stack = [{ directory: root, prefix: '', depth: 0 }]
  let visited = 0
  while (stack.length) {
    signal?.throwIfAborted()
    const { directory, prefix, depth } = stack.pop()
    if (!await checkedPath(root, directory)) continue
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted()
      if (++visited > 30_000) throw new IndexInputError('Слишком много файлов в папке Content.')
      const name = prefix + entry.name
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth < 24) stack.push({ directory: path, prefix: name + '/', depth: depth + 1 })
      } else if (entry.isFile() && isUnrealSourceFile(entry.name)) {
        const file = await fileInfo(root, path)
        if (file) yield { type: unrealFileType(name), name, file }
      }
    }
  }
}
