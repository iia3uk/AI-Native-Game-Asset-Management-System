import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { checkedPath, inside } from '../files/asset-files.mjs'
import { IndexInputError } from '../index/index-errors.mjs'

async function canonicalDestination(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code) || dirname(path) === path) throw error
    return join(await canonicalDestination(dirname(path)), basename(path))
  }
}

export async function packageWorkspaceRoot(directory, name, { sourceRoot } = {}) {
  const ensureDisjoint = path => {
    if (sourceRoot && (inside(sourceRoot, path) || inside(path, sourceRoot))) {
      throw new IndexInputError('Выберите исходную папку вне каталога импорта приложения.')
    }
  }
  if (sourceRoot) {
    ensureDisjoint(directory)
    ensureDisjoint(await canonicalDestination(resolve(directory)))
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const imports = await realpath(directory)
  ensureDisjoint(imports)
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
