import { posix } from 'node:path'

const invalidChars = /[<>:"\\|?*\x00-\x1f\x7f-\x9f]/u
const deviceName = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i
const issueCode = value => typeof value === 'string' && /^unreal-[a-z0-9-]{1,70}$/.test(value)
const textureFormats = new Set(['PF_B8G8R8A8', 'PF_R8G8B8A8', 'PF_G8', 'PF_DXT1', 'PF_DXT5'])
export const pakTextureRevision = 1
export const ioStoreTextureRevision = 1
export const ioStoreAudioRevision = 1
export const looseTextureRevision = 1
export const decoderFormats = new Set(['uasset', 'umap', 'uexp', 'ubulk', 'uptnl', 'png', 'wav', 'fbx', 'glb'])

function validPath(path) {
  if (typeof path !== 'string' || path.length > 768 || invalidChars.test(path)) return false
  const parts = path.split('/')
  return parts.length <= 24 && parts.every(part => part.length > 0 && part.length <= 120 &&
    !/[. ]$/.test(part) && !deviceName.test(part.split('.')[0]))
}

export function pakResult(raw, { inspectOnly, version }) {
  return archiveResult(raw, { inspectOnly, version })
}

const ioStoreKinds = {
  package: new Set(['uasset', 'umap']),
  bulk: new Set(['ubulk', 'uptnl']),
  file: new Set(['png', 'wav', 'fbx', 'glb']),
  registry: new Set(['bin']),
}

export function ioStoreResult(raw, { inspectOnly, version, chunks, partitions }) {
  if (raw?.status === 'completed' && (raw.chunks !== chunks || raw.partitions !== partitions ||
      raw.entries?.length > chunks || raw.textureDecoder !== ioStoreTextureRevision ||
      raw.audioDecoder !== ioStoreAudioRevision)) return null
  return archiveResult(raw, { inspectOnly, version, ioStore: true })
}

function textureProduct(value, file) {
  const { width, height, size, mip, pixelFormat, srgb } = value
  if (![width, height].every(side => Number.isInteger(side) && side >= 1 && side <= 4096) ||
      !Number.isInteger(mip) || mip < 0 || mip > 30 || !textureFormats.has(pixelFormat) || typeof srgb !== 'boolean' ||
      !Number.isSafeInteger(size) || size < 45 || size > width * height * 4 + height + 65536) return null
  return { width, height, size, mip, pixelFormat, srgb, file }
}

export function looseTextureResult(raw, count) {
  if (raw?.protocol !== 1) return null
  if (raw.status === 'failed' && issueCode(raw.issue)) return { status: 'failed', issue: raw.issue }
  if (raw.status !== 'completed' || raw.textureDecoder !== looseTextureRevision ||
      !Array.isArray(raw.entries) || raw.entries.length !== count) return null
  let bytes = 0
  const entries = []
  for (const [index, row] of raw.entries.entries()) {
    if (row?.index !== index) return null
    if (row.texture != null) {
      const texture = textureProduct(row.texture, String(index).padStart(5, '0') + '.png')
      if (row.textureIssue != null || !texture) return null
      bytes += texture.size
      if (bytes > 256 * 1024 ** 2) return null
      entries.push({ texture })
    } else if (row.textureIssue != null) {
      if (!issueCode(row.textureIssue) || !row.textureIssue.startsWith('unreal-cooked-texture-')) return null
      entries.push({ textureIssue: row.textureIssue })
    } else {
      entries.push(null)
    }
  }
  return { status: 'completed', entries }
}

function archiveResult(raw, { inspectOnly, version, ioStore = false }) {
  if (raw?.protocol !== 1) return null
  if (raw.status === 'failed' && issueCode(raw.issue)) return { status: 'failed', issue: raw.issue }
  const revision = ioStore ? ioStoreTextureRevision : pakTextureRevision
  if (raw.status !== 'completed' || raw.containerVersion !== version ||
      !Array.isArray(raw.entries) || raw.entries.length > 10_000 ||
      (raw.textureDecoder !== undefined && raw.textureDecoder !== revision)) return null

  const entries = []
  const names = new Map()
  const chunkIds = ioStore ? new Set() : null
  let outputs = 0
  let bytes = 0
  let derivativeBytes = 0
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
    if (ioStore) {
      if (typeof row.chunkId !== 'string' || !/^[0-9a-f]{24}$/.test(row.chunkId) ||
          chunkIds.has(row.chunkId) || (row.kind !== null && !Object.hasOwn(ioStoreKinds, row.kind))) return null
      chunkIds.add(row.chunkId)
      entry.chunkId = row.chunkId
      if (row.kind !== null) entry.kind = row.kind
    }
    if (row.status === 'skipped' && issueCode(row.issue) && row.output === null) {
      entry.issue = row.issue
    } else {
      if (ioStore ? !ioStoreKinds[row.kind]?.has(format) : !decoderFormats.has(format)) return null
      if (row.size === 0 || row.size > 128 * 1024 ** 2 || row.issue !== null) return null
      if (inspectOnly) {
        if (row.status !== 'available' || row.output !== null) return null
      } else {
        if (row.status !== 'extracted' || row.output !== outputs || outputs >= 4000) return null
        bytes += row.size
        if (bytes > 1024 ** 3) return null
        entry.file = String(outputs++).padStart(5, '0') + '.bin'
      }
    }
    if (row.texture != null || row.textureIssue != null) {
      if (inspectOnly || raw.textureDecoder !== revision || format !== 'uasset' || !entry.file ||
          (ioStore && (entry.kind !== 'package' || version < 5))) return null
      if (row.texture != null) {
        const texture = textureProduct(row.texture, entry.file.replace(/\.bin$/, '.png'))
        if (row.textureIssue != null || !texture) return null
        derivativeBytes += texture.size
        entry.texture = texture
      } else {
        const prefix = ioStore ? 'unreal-iostore-texture-' : 'unreal-cooked-texture-'
        if (!issueCode(row.textureIssue) || !row.textureIssue.startsWith(prefix)) return null
        entry.textureIssue = row.textureIssue
      }
    }
    if (row.audio != null || row.audioIssue != null) {
      if (!ioStore || inspectOnly || format !== 'uasset' || !entry.file || entry.kind !== 'package' || version < 5 ||
          row.texture != null || row.textureIssue != null) return null
      if (row.audio != null) {
        const { format, size } = row.audio
        if (row.audioIssue != null || !['wav', 'ogg'].includes(format) ||
            !Number.isSafeInteger(size) || size < 44 || size > 32 * 1024 ** 2) return null
        derivativeBytes += size
        entry.audio = { format, size, file: entry.file.replace(/\.bin$/, '.' + format) }
      } else {
        if (!issueCode(row.audioIssue) || !row.audioIssue.startsWith('unreal-iostore-audio-')) return null
        entry.audioIssue = row.audioIssue
      }
    }
    if (derivativeBytes > 256 * 1024 ** 2) return null
    entries.push(entry)
  }
  if (bytes + derivativeBytes > 1024 ** 3) return null
  return { status: 'completed', version, entries, textureDecoder: raw.textureDecoder,
    ...(ioStore && { audioDecoder: raw.audioDecoder }) }
}
