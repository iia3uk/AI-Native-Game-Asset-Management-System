import { open } from 'node:fs/promises'
import { posix } from 'node:path'
import { isCollisionFile } from '../public/model-names.js'
import { checkedPath, pathKey, sameFile, ScanChangeError } from './asset-files.mjs'
import { analyzeGltf, analyzeMtl, analyzeObj, isLodName } from './model-analysis.mjs'

export const analysisVersion = 1
export const dependencyLimit = 128
const modelFormats = new Set(['glb', 'gltf', 'vrm', 'obj', 'mtl'])
const imageFormats = new Set(['png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'dds', 'ktx2'])
const headerMax = 256 * 1024
const jsonMax = 16 * 1024 ** 2
const textMax = 24 * 1024 ** 2
const digest = (status, issue, metrics = {}) => ({ status, issues: issue ? [issue] : [], metrics })
export const supportsAnalysis = ext => modelFormats.has(ext) || imageFormats.has(ext)

function location(source, value, { uri, embedded } = {}) {
  const state = location => ({ location, path: null, key: null })
  if (embedded || (uri && typeof value === 'string' && /^data:/i.test(value))) return state('embedded')
  if (typeof value !== 'string' || !value || value.length > 1024) return state('unresolved')
  if (uri && /^[a-z][\w+.-]*:/i.test(value) && !/^[a-z]:|^file:/i.test(value)) return state('external')
  let target = value
  if (uri) {
    if (value.includes('?') || value.includes('#')) return state('unresolved')
    try { target = decodeURIComponent(value) } catch { return state('unresolved') }
  }
  target = target.replaceAll('\\', '/')
  if (/^[\/]|[\0-\x1F:<>|*?"]/.test(target)) return state('outside')
  const path = posix.join(posix.dirname(source), target)
  if (path === '.' || path === '..' || path.startsWith('../')) return state('outside')
  return { location: 'local', path, key: pathKey(path) }
}

async function readPrefix(handle, length, offset = 0) {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, offset + read)
    if (!bytesRead) break
    read += bytesRead
  }
  if (read !== length) throw new ScanChangeError('Файл изменился во время технического анализа.')
  return buffer
}

function jpegSize(buffer) {
  let offset = 2
  while (offset + 3 < buffer.length) {
    if (buffer[offset++] !== 0xff) return null
    while (buffer[offset] === 0xff) offset++
    const marker = buffer[offset++]
    if (marker === 0xd9 || marker === 0xda || offset + 2 > buffer.length) return null
    if (marker === 0x01) continue
    const size = buffer.readUInt16BE(offset)
    if (size < 2 || offset + size > buffer.length) return null
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return size >= 8 ? [buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)] : null
    }
    offset += size
  }
  return null
}

function webpSize(buffer) {
  if (buffer.length < 25 || buffer.toString('latin1', 8, 12) !== 'WEBP') return null
  switch (buffer.toString('latin1', 12, 16)) {
    case 'VP8X': return buffer.length >= 30 ? [1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3)] : null
    case 'VP8L': return buffer[20] === 0x2f
      ? [1 + (buffer.readUInt32LE(21) & 0x3fff), 1 + ((buffer.readUInt32LE(21) >>> 14) & 0x3fff)] : null
    case 'VP8 ': return buffer.length >= 30 && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
      ? [buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff] : null
    default: return null
  }
}

const png = Buffer.from('89504e470d0a1a0a', 'hex')
const ktx2 = Buffer.from('ab4b5458203230bb0d0a1a0a', 'hex')
function imageSize(buffer) {
  const start = buffer.toString('latin1', 0, 6)
  let size
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(png) && buffer.readUInt32BE(8) === 13 &&
      buffer.toString('latin1', 12, 16) === 'IHDR') {
    size = [buffer.readUInt32BE(16), buffer.readUInt32BE(20)]
  } else if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(start)) {
    size = [buffer.readUInt16LE(6), buffer.readUInt16LE(8)]
  } else if (buffer.length >= 128 && start.startsWith('DDS ') && buffer.readUInt32LE(4) === 124) {
    size = [buffer.readUInt32LE(16), buffer.readUInt32LE(12)]
  } else if (buffer.length >= 80 && buffer.subarray(0, 12).equals(ktx2)) {
    size = [buffer.readUInt32LE(20), buffer.readUInt32LE(24)]
  } else if (start.startsWith('RIFF')) size = webpSize(buffer)
  else if (buffer[0] === 0xff && buffer[1] === 0xd8) size = jpegSize(buffer)
  return size?.every(value => value > 0) ? { width: size[0], height: size[1] } : null
}

function dataImageSize(value) {
  if (typeof value !== 'string') return null
  const comma = value.indexOf(',')
  if (comma < 0 || comma > 100 || !/^data:image\/[\w.+-]+;base64$/i.test(value.slice(0, comma))) return null
  return imageSize(Buffer.from(value.slice(comma + 1, comma + 1 + 4 * Math.ceil(headerMax / 3)), 'base64'))
}

async function gltfFile(handle, file, reference) {
  let jsonOffset = 0
  let length = file.info.size
  let binary
  const container = file.ext !== 'gltf'
  if (container) {
    if (length < 20) return digest('invalid', 'invalid-glb-header')
    const header = await readPrefix(handle, 20)
    if (header.toString('latin1', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2 ||
        header.readUInt32LE(8) !== length || header.toString('latin1', 16, 20) !== 'JSON') return digest('invalid', 'invalid-glb-header')
    jsonOffset = 20
    length = header.readUInt32LE(12)
    const afterJson = jsonOffset + length
    if (!length || length % 4 !== 0 || afterJson > file.info.size) return digest('invalid', 'invalid-glb-chunk')
    if (afterJson + 8 <= file.info.size) {
      const chunk = await readPrefix(handle, 8, afterJson)
      const size = chunk.readUInt32LE(0)
      if (afterJson + 8 + size > file.info.size) return digest('invalid', 'invalid-glb-chunk')
      if (chunk.toString('latin1', 4) === 'BIN\0') binary = { start: afterJson + 8, size }
    }
  }
  if (length > jsonMax) return digest('limited', 'analysis-size-limit')
  let document
  try { document = JSON.parse((await readPrefix(handle, length, jsonOffset)).toString('utf8').replace(/^\uFEFF/, '')) }
  catch (error) {
    if (error instanceof SyntaxError) return digest('invalid', 'invalid-document')
    throw error
  }
  const embeddedImages = new Map()
  const result = analyzeGltf(document, Boolean(binary), (role, uri, options) =>
    reference(role, uri, options, role === 'image' ? dataImageSize(uri) : null))
  if (binary && result.status !== 'invalid' && Array.isArray(document.images)) {
    let bytesLeft = 2 * 1024 ** 2
    for (const image of document.images.slice(0, dependencyLimit)) {
      const id = image?.bufferView
      if (!Number.isSafeInteger(id) || id < 0 || image.uri !== undefined || !bytesLeft || embeddedImages.has(id)) continue
      const view = document.bufferViews?.[id]
      if (view?.buffer !== 0) continue
      const { byteOffset = 0, byteLength } = view
      if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(byteLength) ||
          byteLength <= 0 || byteOffset + byteLength > binary.size) continue
      const size = Math.min(byteLength, headerMax, bytesLeft)
      bytesLeft -= size
      embeddedImages.set(id, imageSize(await readPrefix(handle, size, binary.start + byteOffset)))
    }
  }
  return { ...result, embeddedImages }
}

export async function analyzeAsset(root, file, signal) {
  signal?.throwIfAborted()
  const { ext, path, info } = file
  const references = new Map()
  let dependenciesTruncated = false
  const reference = (role, value, options, dimensions = null) => {
    const target = location(path, value, options)
    const slot = options?.slot ?? ''
    const key = [role, target.location, target.key, slot].join('\0')
    if (references.has(key)) return
    if (references.size >= dependencyLimit) {
      dependenciesTruncated = true
      return
    }
    references.set(key, { role, ...target, dimensions, imageView: options?.imageView })
  }
  const handle = await open(file.absolute, 'r')
  let report
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(info, opened) || !await checkedPath(root, file.absolute)) {
      throw new ScanChangeError('Файл изменился во время технического анализа.')
    }
    if (imageFormats.has(ext)) {
      const size = imageSize(await readPrefix(handle, Math.min(info.size, headerMax)))
      report = size ? digest('analyzed', null, size) : digest('limited', 'image-dimensions-unknown')
    } else if (ext === 'obj' || ext === 'mtl') {
      if (info.size > (ext === 'mtl' ? 4 * 1024 ** 2 : textMax)) report = digest('limited', 'analysis-size-limit')
      else {
        const text = (await readPrefix(handle, info.size)).toString('utf8')
        try { report = (ext === 'obj' ? analyzeObj : analyzeMtl)(text, reference) }
        catch (error) {
          if (!(error instanceof RangeError)) throw error
          report = digest('limited', 'analysis-size-limit')
        }
      }
    } else report = await gltfFile(handle, file, reference)
    signal?.throwIfAborted()
    if (!sameFile(opened, await handle.stat()) || !await checkedPath(root, file.absolute)) {
      throw new ScanChangeError('Файл изменился во время технического анализа.')
    }
  } finally {
    await handle.close()
  }
  const { embeddedImages, ...analysis } = report
  if ('collisionNamed' in analysis.metrics) {
    analysis.metrics.collisionNamed ||= isCollisionFile({ kind: 'model', path, name: posix.basename(path) })
    analysis.metrics.lod ||= isLodName(posix.basename(path))
  }
  const dependencies = [...references.values()].map(({ imageView, dimensions, ...reference }) =>
    ({ ...reference, dimensions: dimensions ?? embeddedImages?.get(imageView) ?? null }))
  return { ...analysis, dependencies, dependenciesTruncated }
}
