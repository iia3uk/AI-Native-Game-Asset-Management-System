import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { checkedPath, fileInfo, pathKey } from '../../../files/asset-files.mjs'
import { sameSource } from '../../../files/hash.mjs'
import { checkPathTree, segments } from '../paths.mjs'
import { invalid } from '../policy.mjs'
import { folderChanged } from './read-file.mjs'

const pathOrder = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0

export async function folderInventory(root, mounts, limits, signal) {
  const queue = [...mounts]
  const roots = new Set(mounts.map(mount => mount.logical))
  const physicalRoots = new Set(mounts.map(mount => pathKey(mount.path)))
  if (roots.size !== mounts.length) throw invalid('имя встроенного пакета повторяется.')
  const tree = new Map()
  const folders = new Map()
  const files = new Map()
  const stamps = []
  let discovered = 0
  while (queue.length) {
    signal?.throwIfAborted()
    const { path, logical } = queue.pop()
    segments(logical)
    if (!await checkedPath(root, path)) throw folderChanged()
    const info = await lstat(path)
    if (!info.isDirectory()) throw folderChanged()
    stamps.push({ path, info })
    checkPathTree(tree, logical, true)
    if (!roots.has(logical)) folders.set(logical, null)
    for await (const child of await opendir(path)) {
      signal?.throwIfAborted()
      if (++discovered > limits.entries) throw invalid('превышен лимит записей в папке.')
      if (child.name.startsWith('.')) continue
      if (roots.has(logical) && logical.startsWith('Packages/') && child.name === 'package.json') continue
      const absolute = join(path, child.name)
      const relative = logical + '/' + child.name
      if (child.isDirectory()) {
        if (physicalRoots.has(pathKey(absolute))) continue
        queue.push({ path: absolute, logical: relative })
      } else if (child.isFile()) {
        segments(relative)
        const file = await fileInfo(root, absolute)
        if (!file) throw folderChanged()
        checkPathTree(tree, relative, false)
        files.set(relative, file)
      }
    }
  }
  const rows = [...folders, ...[...files].filter(([path]) => !path.endsWith('.meta'))]
  return {
    rows: rows.sort(pathOrder).map(([path, file]) => ({ path, file, metadata: files.get(path + '.meta') })),
    async verify() {
      for (const { path, info } of stamps) {
        signal?.throwIfAborted()
        const current = await checkedPath(root, path) && await lstat(path).catch(() => null)
        if (!current?.isDirectory() || !sameSource(info, current)) throw folderChanged()
      }
    },
  }
}
