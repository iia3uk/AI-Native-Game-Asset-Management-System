import { open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { checkedPath, fileInfo, readBoundedText } from '../../../files/asset-files.mjs'
import { sameSource } from '../../../files/hash.mjs'
import { validPackageSegment } from '../../../packages/source.mjs'

export const bundleInputLimit = 128 * 1024 ** 2
const limit = 8
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,119}$/
const signature = Buffer.from('UnityFS\0')

export function declaredBundleDependencies(text) {
  if (!text) return []
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0] !== 'ManifestFileVersion: 0') return []
  const heading = lines.indexOf('Dependencies:')
  if (heading < 0) return []
  const dependencies = []
  for (const line of lines.slice(heading + 1)) {
    if (!line.startsWith('- ')) break
    // A native manifest can contain the original build machine's absolute path.
    const parts = line.slice(2).split(/[\\/]/)
    const name = parts.at(-1)
    if (!parts.some(part => part === '.' || part === '..') &&
        namePattern.test(name) && validPackageSegment(name, 120)) dependencies.push(name)
    if (dependencies.length > limit) break
  }
  return dependencies
}

export async function findBundleDependencies(root, source, signal) {
  const folder = dirname(source.path)
  const first = basename(source.path)
  const seen = new Set([first.toLowerCase()])
  const manifests = [first]
  const found = []
  let bytes = source.info.size
  for (const owner of manifests) {
    signal?.throwIfAborted()
    const text = await readBoundedText(root, join(folder, owner + '.manifest'), 256 * 1024)
    for (const name of declaredBundleDependencies(text)) {
      if (found.length === limit) return found
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const file = await fileInfo(root, join(folder, name))
      if (!file || file.info.size < 48 || bytes + file.info.size > bundleInputLimit ||
          !await hasBundleSignature(root, file)) continue
      bytes += file.info.size
      manifests.push(name)
      found.push({ name, role: 'bundle', file, staged: 'dependency-' + (found.length + 1) + '.bundle' })
    }
  }
  return found
}

async function hasBundleSignature(root, file) {
  const handle = await open(file.path, 'r')
  try {
    if (!sameSource(await handle.stat(), file.info) || !await checkedPath(root, file.path)) return false
    const data = Buffer.alloc(signature.length)
    const { bytesRead } = await handle.read(data)
    return bytesRead === data.length && data.equals(signature)
  } finally {
    await handle.close()
  }
}
