import { opendir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { checkedPath, folderPath, inside, portablePath } from '../files/asset-files.mjs'
import { IndexInputError } from '../index/index-errors.mjs'
import { probePackageFormat } from './detect.mjs'
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

export async function scanPackageFolder(input, { ignoredPaths = [], signal } = {}) {
  const root = await folderPath(input).catch(error => {
    throw new IndexInputError(unavailable(error) ? 'Папка с пакетами недоступна.' : error.message)
  })
  if (root.length > 4096) throw new IndexInputError('Путь к папке с пакетами слишком длинный.')
  const excluded = await exclusions(ignoredPaths)
  const isExcluded = path => excluded.some(dir => inside(dir, path))
  if (isExcluded(root)) throw new IndexInputError('Выберите папку за пределами служебных папок Asset Viewer.')

  const packages = []
  const pending = [root]
  let visited = 0
  let skipped = 0
  let truncated = false
  scan: while (pending.length) {
    signal?.throwIfAborted()
    const folder = pending.pop()
    const directory = await checkedPath(root, folder) && await opendir(folder).catch(error => {
      if (unavailable(error)) return null
      throw error
    })
    if (!directory) {
      if (folder === root) throw new IndexInputError('Папка с пакетами недоступна.')
      skipped++
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
      if (absolute.length > 4096 || !validPackageSegment(entry.name) || isExcluded(absolute)) continue
      if (entry.isDirectory()) pending.push(absolute)
      if (!entry.isFile()) continue
      const format = await probePackageFormat({ root, path: absolute }, { signal }).catch(error => {
        if (!(error instanceof IndexInputError) && !unavailable(error)) throw error
        skipped++
        return null
      })
      if (!format) continue
      if (packages.length >= packageLimit) {
        truncated = true
        break scan
      }
      packages.push({ path: portablePath(relative(root, absolute)), format })
    }
  }
  packages.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return { root, packages, visited, skipped, truncated }
}
