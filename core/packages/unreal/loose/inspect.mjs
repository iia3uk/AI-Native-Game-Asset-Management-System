import { createHash } from 'node:crypto'
import { mkdir, opendir, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'
import { validPackageSegment } from '../../source.mjs'
import { collectUnrealContent, inspectUnrealFile } from '../inspect.mjs'
import { unrealFileType } from '../source.mjs'

const MiB = 1024 ** 2
const perFile = 512 * MiB
const maxSize = 8 * 1024 * MiB
const primaryTypes = new Set(['uasset', 'umap'])
const primaryStorage = new Set(['editor', 'cooked', 'unversioned'])
const sidecars = ['uexp', 'ubulk', 'uptnl', 'm.ubulk']
const order = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0
const key = path => path.normalize('NFC').toLowerCase()
const packagesKey = path => key(path).replace(/\.(?:uasset|umap|(?:m\.)?(?:uexp|ubulk|uptnl))$/, '')
const companionType = type => sidecars.includes(type)
const assetId = path => createHash('sha256').update(key(path)).digest('hex').slice(0, 32)
export const unrealSourceChanged = () => new IndexInputError('Ресурсы Unreal изменились после анализа. Проанализируйте источник снова.')

async function singlePackage(source, signal) {
  const entry = await inspectUnrealFile(source.root, source, signal)
  const stem = source.name.slice(0, -(source.type.length + 1))
  const files = [{ ...entry, file: source.file }]
  const names = new Set(sidecars.map(extension => key(stem + '.' + extension)))
  let visited = 0
  for await (const entry of await opendir(source.root)) {
    signal?.throwIfAborted()
    if (++visited > 30_000) throw new IndexInputError('Слишком много файлов в исходной папке Unreal.')
    if (!entry.isFile() || !names.has(key(entry.name))) continue
    const file = await fileInfo(source.root, entry.name)
    if (file) files.push({ path: entry.name, file, size: file.info.size, type: unrealFileType(entry.name), storage: 'companion' })
  }
  return files
}

function groupContent(entries) {
  const paths = new Map()
  const groups = new Map()
  for (const entry of entries) {
    const parts = entry.path.split('/')
    if (entry.path.length > 1024 || parts.some(part => !validPackageSegment(part))) {
      throw new IndexInputError('Недопустимый путь ресурса Unreal.')
    }
    let path = ''
    for (const [index, part] of parts.entries()) {
      path += '/' + part
      const folder = index < parts.length - 1
      const name = key(path)
      const previous = paths.get(name)
      if (previous && (!folder || !previous.folder || previous.path !== path)) {
        throw new IndexInputError('Пути ресурсов Unreal совпадают без учёта регистра или формы Unicode.')
      }
      paths.set(name, { path, folder })
    }
    if (primaryTypes.has(entry.type) || companionType(entry.type)) {
      const stem = packagesKey(entry.path)
      if (!groups.has(stem)) groups.set(stem, [])
      groups.get(stem).push(entry)
    }
  }
  return groups
}

function packageIssue(entry, groups) {
  if (entry.type === 'asset-registry') {
    return entry.size === 0 ? 'unreal-asset-registry-empty' : entry.size > perFile ? 'unreal-input-limit' : null
  }
  if (!primaryTypes.has(entry.type) && !companionType(entry.type)) {
    return entry.issue ?? 'unreal-use-container-import'
  }
  const group = groups.get(packagesKey(entry.path))
  const primaries = group.filter(file => primaryTypes.has(file.type))
  if (primaries.length > 1) return 'unreal-package-companion-ambiguous'
  if (!primaries.length || !primaryStorage.has(primaries[0].storage)) return entry.issue ?? 'unreal-companion-orphan'
  if (group.some(file => file.size > perFile)) return 'unreal-input-limit'
  return null
}

export async function readUnrealLoose(source, { output, signal, onProgress } = {}) {
  const entries = primaryTypes.has(source.type) ? await singlePackage(source, signal) :
    await collectUnrealContent(source, signal)
  const groups = groupContent(entries)
  const root = source.root
  const fingerprint = createHash('sha256').update(JSON.stringify([
    'unreal-loose-v1', source.format, source.association ?? null, source.descriptorVersion ?? null,
  ]))
  const assets = []
  const dependencies = []
  const copied = new Set()
  let size = 0
  let nextSpaceCheck = 0
  for (const { file, ...entry } of entries.sort(order)) {
    signal?.throwIfAborted()
    const issue = packageIssue(entry, groups)
    const available = !issue
    const id = assetId(entry.path)
    const target = available ? 'Source/Content/' + entry.path : null
    if (available && size + file.info.size > maxSize) throw new IndexInputError('Размер исходных ресурсов Unreal превышает 8 ГиБ.')
    const temporary = output && target ? join(output, target) : undefined
    if (temporary) {
      if (size + entry.size >= nextSpaceCheck) {
        const space = await statfs(output, { bigint: true })
        if (space.bavail * space.bsize < BigInt(128 * MiB + entry.size)) {
          throw new IndexInputError('Недостаточно свободного места для ресурсов Unreal.')
        }
        nextSpaceCheck = size + entry.size + 32 * MiB
      }
      await mkdir(dirname(temporary), { recursive: true })
    }
    const record = available && await readVerifiedFile(root, file, { temporary, signal, changed: unrealSourceChanged })
    if (record) {
      size += record.size
      copied.add(entry.path)
    }
    fingerprint.update(JSON.stringify([entry.path, entry.type, entry.storage, entry.size, record?.hash, issue]))
    const diagnostic = issue ?? entry.issue
    assets.push({ ...entry, ...(diagnostic && { issue: diagnostic }), id, sourcePath: entry.path, output: target, hash: record?.hash ?? null,
      status: available ? 'extracted' : 'unsupported', method: 'unreal-loose-direct', license: null,
      issues: diagnostic ? [diagnostic] : [], exports: [] })
    onProgress?.(Math.floor(60 * assets.length / entries.length))
  }
  for (const group of groups.values()) {
    const primary = group.find(entry => primaryTypes.has(entry.type))
    if (!primary || !copied.has(primary.path)) continue
    for (const entry of group) {
      if (entry === primary || !copied.has(entry.path)) continue
      dependencies.push({ source: assetId(primary.path), target: assetId(entry.path), path: entry.path,
        type: 'unreal-package-companion', status: 'resolved' })
      dependencies.push({ source: assetId(entry.path), target: assetId(primary.path), path: primary.path,
        type: 'unreal-package-companion', status: 'resolved' })
    }
  }
  return { hash: fingerprint.digest('hex'), assets, dependencies, size, written: copied.size }
}

export async function inspectUnrealLoose(source, { signal } = {}) {
  const { hash, assets, size } = await readUnrealLoose(source, { signal })
  return { format: source.format, descriptorVersion: source.descriptorVersion, engineVersion: source.association ?? null,
    hash, size, total: assets.length, assets: assets.slice(0, 500) }
}
