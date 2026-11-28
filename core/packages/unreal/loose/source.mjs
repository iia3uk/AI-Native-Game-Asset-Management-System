import { opendir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { checkedPath, pathKey } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'
import { unrealContentFiles, unrealFileType, unrealSource } from '../source.mjs'

export const isUnrealLoose = format => ['unreal-project', 'unreal-content', 'unreal-asset'].includes(format)
const packageTypes = new Set(['uasset', 'umap'])

export async function unrealLooseSource(source, signal) {
  let path = source.path
  if (source.directory && basename(path).toLowerCase() !== 'content') {
    if (!await checkedPath(source.root, path)) return null
    let descriptor
    let visited = 0
    for await (const file of await opendir(path)) {
      signal?.throwIfAborted()
      if (++visited > 4000) throw new IndexInputError('Укажите конкретный файл проекта Unreal (.uproject).')
      if (!file.isFile() || unrealFileType(file.name) !== 'uproject') continue
      if (descriptor) throw new IndexInputError('В папке несколько проектов Unreal. Выберите файл .uproject.')
      descriptor = join(path, file.name)
    }
    if (!descriptor) {
      for await (const file of unrealContentFiles(source.root, signal)) {
        if (!packageTypes.has(file.type)) continue
        return { ...source, type: 'content', format: 'unreal-content', selectedDirectory: true, protectedRoot: source.root }
      }
      return null
    }
    path = descriptor
  } else if (!source.directory && !['uproject', 'uasset', 'umap'].includes(unrealFileType(path))) {
    return null
  }
  if (!await checkedPath(source.root, path)) throw new IndexInputError('Исходная папка Unreal изменилась.')
  const data = await unrealSource(path)
  const protectedRoot = data.projectRoot ?? data.root
  if (pathKey(protectedRoot) !== pathKey(source.root)) throw new IndexInputError('Исходная папка Unreal изменилась.')
  const format = data.type === 'uproject' ? 'unreal-project' : data.type === 'content' ? 'unreal-content' : 'unreal-asset'
  return { ...data, format, selectedDirectory: source.directory === true, protectedRoot }
}
