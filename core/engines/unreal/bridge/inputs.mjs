import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileInfo, sameFile } from '../../../files/asset-files.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'
import { collectUnrealContent } from '../../../packages/unreal/inspect.mjs'

const MiB = 1024 ** 2
const companions = ['uexp', 'ubulk', 'uptnl', 'm.ubulk']
const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i
const component = /^[\p{L}\p{N}_]{1,96}$/u

export function unrealMountName(path) {
  const stem = path.slice(0, -'.uasset'.length)
  const parts = stem.split('/')
  return /\.uasset$/i.test(path) && stem.length <= 240 && parts.every(name => component.test(name) && !reserved.test(name))
    ? '/Game/' + stem : null
}

async function copyChecked(source, project, entry) {
  const read = () => fileInfo(source.root, entry.path)
  const before = await read()
  if (!before || !sameFile(before.info, entry.file.info)) throw new IndexInputError('Исходный файл Unreal изменился.')
  const path = join(project, 'Content', entry.path)
  await mkdir(dirname(path), { recursive: true })
  await copyFile(before.path, path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  const after = await read()
  if (!after || !sameFile(before.info, after.info)) throw new IndexInputError('Исходный файл Unreal изменился.')
}

export async function stageUnrealContent(source, project, signal) {
  const entries = await collectUnrealContent(source, signal)
  const files = new Map()
  const names = new Map()
  for (const entry of entries) {
    const parts = entry.path.split('/')
    let path = ''
    for (const part of parts) {
      path += '/' + part
      const key = path.normalize('NFC').toLowerCase()
      names.set(key, names.has(key) && names.get(key) !== path ? null : path)
    }
    const key = entry.path.normalize('NFC').toLowerCase()
    if (files.has(key)) throw new IndexInputError('Имена файлов Unreal совпадают без учёта регистра.')
    files.set(key, entry)
  }
  if ([...names.values()].includes(null)) throw new IndexInputError('Имена папок Unreal совпадают без учёта регистра.')
  const targets = []
  const issues = []
  let bytes = 0
  let fileCount = 0
  for (const entry of entries) {
    if (entry.type !== 'uasset') {
      if (['umap', 'pak', 'utoc', 'ucas', 'asset-registry'].includes(entry.type)) {
        issues.push({ sourcePath: entry.path, issue: entry.issue ?? 'unreal-input-not-editor-asset' })
      }
      continue
    }
    signal?.throwIfAborted()
    const packageName = unrealMountName(entry.path)
    if (!packageName || entry.storage !== 'editor' || entry.issue) {
      issues.push({ sourcePath: entry.path, issue: entry.issue ?? (packageName ? 'unreal-' + entry.storage : 'unreal-mount-path') })
      continue
    }
    const key = entry.path.normalize('NFC').toLowerCase().slice(0, -'.uasset'.length)
    const group = [entry, ...companions.map(ext => files.get(key + '.' + ext)).filter(Boolean)]
    const size = group.reduce((sum, file) => sum + file.size, 0)
    if (fileCount + group.length > 4000 || bytes + size > 2 * 1024 * MiB || group.some(file => file.size > 512 * MiB)) {
      issues.push({ sourcePath: entry.path, issue: 'unreal-input-limit' })
      continue
    }
    const space = await statfs(project, { bigint: true })
    if (space.bavail * space.bsize < BigInt(size + 768 * MiB)) {
      issues.push({ sourcePath: entry.path, issue: 'unreal-space-limit' })
      continue
    }
    for (const file of group) {
      signal?.throwIfAborted()
      await copyChecked(source, project, file)
    }
    bytes += size
    fileCount += group.length
    targets.push({ id: createHash('sha256').update(key).digest('hex').slice(0, 32),
      packageName, sourcePath: entry.path, files: group.map(file => ({ path: file.path, size: file.size })) })
  }
  return { targets, issues, bytes, fileCount }
}
