import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { checkedPath } from '../files/asset-files.mjs'
import { IndexInputError } from '../index/index-errors.mjs'

export async function packageWorkspaceRoot(directory, name) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const imports = await realpath(directory)
  const root = join(imports, name)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (!await checkedPath(imports, root)) throw new IndexInputError('Каталог импорта пакетов недоступен.')
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.stage-[a-zA-Z0-9]{6}$/.test(entry.name)) continue
    const path = await checkedPath(root, entry.name)
    if (path && Date.now() - (await lstat(path)).mtimeMs > 60 * 60_000) await rm(path, { recursive: true, force: true })
  }
  return root
}
