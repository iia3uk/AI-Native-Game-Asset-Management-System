import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { lstat, lutimes, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { checkedPath } from '../files/asset-files.mjs'

const maxAge = 30 * 24 * 60 * 60_000
const pngSizeLimit = 128 * 1024
const signature = Buffer.from('89504e470d0a1a0a', 'hex')
const entry = /^[a-f0-9]{64}\.png$/
const partial = /^\.[a-f0-9-]{36}\.partial$/
const absent = error => error.code === 'ENOENT'

export class ThumbnailCache {
  constructor(directory, limit = Number(process.env.ASSET_VIEWER_THUMBNAIL_CACHE_BYTES ?? 64 * 1024 ** 2)) {
    if (!Number.isSafeInteger(limit) || limit < pngSizeLimit) throw new Error('Invalid thumbnail cache size.')
    this.directory = directory
    this.limit = limit
  }

  async get(key) {
    if (!/^[a-f\d]{64}$/.test(key)) return null
    const path = join(this.directory, key + '.png')
    const info = await lstat(path).catch(error => { if (!absent(error)) throw error })
    if (!info?.isFile() || info.size <= signature.length || info.size > pngSizeLimit || info.mtimeMs <= Date.now() - maxAge) return null
    return { path, size: info.size }
  }

  async read(key, { touch = true } = {}) {
    const cached = await this.get(key)
    if (!cached) return null
    const root = await realpath(this.directory).catch(error => { if (!absent(error)) throw error })
    if (!root) return null
    const path = await checkedPath(root, basename(cached.path))
    if (!path) return null
    const handle = await open(path, 'r').catch(error => { if (!absent(error)) throw error })
    if (!handle) return null
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size !== cached.size || !await checkedPath(root, path)) return null
      const data = Buffer.alloc(cached.size)
      let length = 0
      while (length < data.length) {
        const { bytesRead } = await handle.read(data, length, data.length - length, length)
        if (!bytesRead) return null
        length += bytesRead
      }
      if (!data.subarray(0, signature.length).equals(signature)) return null
      if (touch) {
        const now = new Date()
        await lutimes(path, now, now).catch(error => {
          if (!['ENOENT', 'EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error
        })
      }
      return data
    } finally {
      await handle.close()
    }
  }

  async put(key, image, signal, publish = rename => rename()) {
    if (!/^[a-f\d]{64}$/.test(key) || image.length > pngSizeLimit ||
        !signature.equals(image.subarray(0, signature.length))) throw new Error('Invalid thumbnail cache entry.')
    await mkdir(this.directory, { recursive: true })
    const name = key + '.png'
    const temporary = join(this.directory, '.' + randomUUID() + '.partial')
    try {
      await writeFile(temporary, image, { flag: 'wx', signal })
      signal?.throwIfAborted()
      publish(() => renameSync(temporary, join(this.directory, name)))
      await this.#prune(name)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async usage() {
    const files = (await this.#entries()).filter(file => entry.test(file.name))
    return { entries: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), limit: this.limit }
  }

  async clear() {
    const files = (await this.#entries()).filter(file => entry.test(file.name))
    for (const { name } of files) await rm(join(this.directory, name), { force: true })
    return this.usage()
  }

  async maintain() {
    await this.#prune()
  }

  async #entries() {
    const names = await readdir(this.directory, { withFileTypes: true }).catch(error => {
      if (!absent(error)) throw error
      return []
    })
    const files = []
    for (const { name } of names) {
      if (!entry.test(name) && !partial.test(name)) continue
      const info = await lstat(join(this.directory, name)).catch(error => { if (!absent(error)) throw error })
      if (info?.isFile()) files.push({ name, size: info.size, mtime: info.mtimeMs })
    }
    return files
  }

  async #prune(keep) {
    const files = await this.#entries()
    let bytes = files.filter(file => entry.test(file.name)).reduce((sum, file) => sum + file.size, 0)
    const now = Date.now()
    files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
    for (const file of files) {
      if (file.name === keep) continue
      const cached = entry.test(file.name)
      if (cached ? bytes <= this.limit && file.mtime > now - maxAge : file.mtime > now - 60 * 60_000) continue
      const path = join(this.directory, file.name)
      const current = await lstat(path).catch(error => { if (!absent(error)) throw error })
      if (!current?.isFile() || current.mtimeMs !== file.mtime || current.size !== file.size) continue
      await rm(path, { force: true })
      if (cached) bytes -= file.size
    }
  }
}
