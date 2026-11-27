import { constants } from 'node:fs'
import { access, opendir, open, realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, normalize, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const maxConfig = 2 * 1024 ** 2
const maxChildren = 512
const readOnly = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)
const local = value => typeof value === 'string' && !/[\x00-\x1f]/.test(value) && isAbsolute(value) &&
  (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value))

export function configuredPaths(value) {
  return typeof value === 'string' ? value.split(delimiter).filter(local).slice(0, 32) : []
}

export async function directories(path, filter = () => true) {
  if (!local(path)) return []
  try {
    const candidates = []
    let visited = 0
    for await (const entry of await opendir(path)) {
      if (++visited > maxChildren) break
      if ((entry.isDirectory() || entry.isSymbolicLink()) && filter(entry.name)) candidates.push(entry.name)
      if (candidates.length === 64) break
    }
    return candidates
  } catch {
    return []
  }
}

export async function smallText(path, limit = maxConfig) {
  if (!local(path)) return null
  let handle
  try {
    handle = await open(path, readOnly)
    const file = await handle.stat()
    if (!file.isFile() || file.size > limit) return null
    const bytes = Buffer.alloc(file.size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    return length === file.size ? bytes.toString('utf8', 0, length).replace(/^\uFEFF/, '') : null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

export async function smallJson(path) {
  const text = await smallText(path)
  try { return text === null ? null : JSON.parse(text) } catch { return null }
}

export async function executable(path) {
  if (!local(path) || (process.platform === 'win32' && !/\.exe$/i.test(path))) return null
  try {
    const canonical = await realpath(path)
    const handle = await open(canonical, readOnly)
    try {
      if (!(await handle.stat()).isFile()) return null
      if (process.platform === 'win32') {
        const header = Buffer.alloc(2)
        if ((await handle.read(header)).bytesRead !== 2 || header.toString('ascii') !== 'MZ') return null
      } else await access(canonical, constants.X_OK)
      return canonical
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export async function registryValues(env, key) {
  const { SystemRoot } = env
  if (process.platform !== 'win32' || !local(SystemRoot)) return []
  try {
    const { stdout } = await run(resolve(SystemRoot, 'System32/reg.exe'), ['query', key],
      { timeout: 3000, windowsHide: true, maxBuffer: 128 * 1024 })
    return stdout.split(/\r?\n/).map(line => line.match(/^\s+(.+?)\s+REG_SZ\s+(.+)$/))
      .filter(Boolean).map(([, name, path]) => ({ name, path: path.trim() })).slice(0, 64)
  } catch {
    return []
  }
}

export function uniqueExecutables(candidates) {
  const unique = new Map()
  for (const item of candidates.filter(Boolean)) {
    const normalized = normalize(item.executable)
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    const prior = unique.get(key)
    if (!prior) unique.set(key, item)
    else {
      const merged = { ...prior, version: prior.version ?? item.version }
      if (prior.associations || item.associations) {
        merged.associations = [...new Set([...(prior.associations ?? []), ...(item.associations ?? [])])]
      }
      unique.set(key, merged)
    }
  }
  return [...unique.values()]
}

export function absolutePath(value) {
  return local(value) ? normalize(value) : null
}

export async function verifyCandidates(candidates, verify) {
  const checked = []
  for (let offset = 0; offset < candidates.length; offset += 32) {
    checked.push(...await Promise.all(candidates.slice(offset, offset + 32).map(verify)))
  }
  return uniqueExecutables(checked)
}
