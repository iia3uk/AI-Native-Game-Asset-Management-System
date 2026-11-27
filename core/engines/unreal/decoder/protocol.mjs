import { posix } from 'node:path'

const invalidChars = /[<>:"\\|?*\x00-\x1f\x7f-\x9f]/u
const deviceName = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i
const issueCode = value => typeof value === 'string' && /^unreal-[a-z0-9-]{1,70}$/.test(value)
export const decoderFormats = new Set(['uasset', 'umap', 'uexp', 'ubulk', 'uptnl', 'png', 'wav', 'fbx', 'glb'])

function validPath(path) {
  if (typeof path !== 'string' || path.length > 768 || invalidChars.test(path)) return false
  const parts = path.split('/')
  return parts.length <= 24 && parts.every(part => part.length > 0 && part.length <= 120 &&
    !/[. ]$/.test(part) && !deviceName.test(part.split('.')[0]))
}

export function pakResult(raw, { inspectOnly, version }) {
  if (raw?.protocol !== 1) return null
  if (raw.status === 'failed' && issueCode(raw.issue)) return { status: 'failed', issue: raw.issue }
  if (raw.status !== 'completed' || raw.containerVersion !== version ||
      !Array.isArray(raw.entries) || raw.entries.length > 10_000) return null

  const entries = []
  const names = new Map()
  let outputs = 0
  let bytes = 0
  for (const row of raw.entries) {
    if (!validPath(row?.path) || !Number.isSafeInteger(row.size) || row.size < 0) return null
    const parts = row.path.split('/')
    let path = ''
    for (const [index, part] of parts.entries()) {
      path += '/' + part
      const key = path.normalize('NFC').toLowerCase()
      const directory = index < parts.length - 1
      const previous = names.get(key)
      if (previous && (!directory || !previous.directory || previous.path !== path)) return null
      names.set(key, { directory, path })
    }
    const format = posix.extname(row.path).slice(1).toLowerCase()
    const entry = { path: row.path, size: row.size, format, status: row.status }
    if (row.status === 'skipped' && issueCode(row.issue) && row.output === null) {
      entry.issue = row.issue
    } else {
      if (!decoderFormats.has(format) || row.size === 0 || row.size > 128 * 1024 ** 2 || row.issue !== null) return null
      if (inspectOnly) {
        if (row.status !== 'available' || row.output !== null) return null
      } else {
        if (row.status !== 'extracted' || row.output !== outputs || outputs >= 4000) return null
        bytes += row.size
        if (bytes > 1024 ** 3) return null
        entry.file = String(outputs++).padStart(5, '0') + '.bin'
      }
    }
    entries.push(entry)
  }
  return { status: 'completed', version, entries }
}
