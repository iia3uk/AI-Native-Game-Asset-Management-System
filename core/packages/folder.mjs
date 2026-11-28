import { opendir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { checkedPath, folderPath, inside, portablePath } from '../files/asset-files.mjs'
import { IndexInputError } from '../index/index-errors.mjs'
import { probePackageFormat } from './detect.mjs'
import { PackageFolders } from './discovery/structured.mjs'
import { scopedPackageSource, validPackageSegment } from './source.mjs'

const entryLimit = 20_000
const packageLimit = 500
const unavailable = error => ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EINVAL'].includes(error.code)

async function exclusions(paths) {
  return Promise.all(paths.map(path => realpath(path).catch(error => {
    if (!unavailable(error)) throw error
    return resolve(path)
  })))
}

export async function folderPackageSource(root, path, ignoredPaths = []) {
  const source = await scopedPackageSource(root, path)
  if ((await exclusions(ignoredPaths)).some(dir => inside(dir, source.path))) {
    throw new IndexInputError('Выберите пакет за пределами служебных папок Asset Viewer.')
  }
  return source
}

export async function scanPackageFolder(input, { ignoredPaths = [], signal, structured = false } = {}) {
  const root = await folderPath(input).catch(error => {
    throw new IndexInputError(unavailable(error) ? 'Папка с пакетами недоступна.' : error.message)
  })
  if (root.length > 4096) throw new IndexInputError('Путь к папке с пакетами слишком длинный.')
  const excluded = await exclusions(ignoredPaths)
  const isExcluded = path => excluded.some(dir => inside(dir, path))
  if (isExcluded(root)) throw new IndexInputError('Выберите папку за пределами служебных папок Asset Viewer.')

  const packages = []
  const groups = structured && new PackageFolders()
  const pending = [{ path: root }]
  const candidate = ({ path, format }) => ({ path: portablePath(relative(root, path)) || '.', format })
  let visited = 0
  let skipped = 0
  let truncated = false
  scan: while (pending.length) {
    signal?.throwIfAborted()
    const { path: folder, parent } = pending.pop()
    const directory = await checkedPath(root, folder) && await opendir(folder).catch(error => {
      if (unavailable(error)) return null
      throw error
    })
    if (!directory) {
      if (folder === root) throw new IndexInputError('Папка с пакетами недоступна.')
      skipped++
      continue
    }
    const group = groups && await groups.visit(folder, parent).catch(async error => {
      await directory.close()
      throw error
    })
    if (group?.unity) {
      await directory.close()
      continue
    }
    for await (const entry of directory) {
      signal?.throwIfAborted()
      if (visited >= entryLimit) {
        truncated = true
        break scan
      }
      visited++
      const absolute = join(folder, entry.name)
      if (isExcluded(absolute)) {
        if (group && entry.isDirectory()) group.excluded = true
        continue
      }
      if (absolute.length > 4096 || !validPackageSegment(entry.name)) continue
      if (entry.isDirectory()) pending.push({ path: absolute, parent: group })
      if (!entry.isFile()) continue
      const format = await probePackageFormat({ root, path: absolute }, { signal, looseUnreal: structured }).catch(error => {
        if (!(error instanceof IndexInputError) && !unavailable(error)) throw error
        skipped++
        return null
      })
      groups && groups.recordFile(group, absolute, format)
      if (!format || format === 'unreal-asset') continue
      if (packages.length >= packageLimit) {
        truncated = true
        break scan
      }
      packages.push(candidate({ path: absolute, format }))
    }
  }
  if (groups && !truncated) {
    for (const scope of groups.scopes()) packages.push(candidate(scope))
    if (packages.length > packageLimit) {
      packages.length = packageLimit
      truncated = true
    }
  }
  packages.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return { root, packages, visited, skipped, truncated }
}
