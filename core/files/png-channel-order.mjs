import { deflateSync, inflateSync } from 'node:zlib'
import { pngChunk } from './png.mjs'
import { embeddedPng, pngMagic } from './png-structure.mjs'

const pixelLimit = 16 * 1024 ** 2
const byteLimit = 64 * 1024 ** 2
const ancillary = new Set(['cHRM', 'gAMA', 'iCCP', 'sRGB', 'pHYs', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf'])

export function swapPngRedBlue(bytes, signal) {
  if (bytes.length > byteLimit || bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) return null
  const info = embeddedPng(bytes, 0)
  if (info?.end !== bytes.length || info.width * info.height > pixelLimit) return null

  const idat = []
  const parts = [pngMagic]
  let dataIndex
  for (let start = pngMagic.length; start < bytes.length;) {
    const length = bytes.readUInt32BE(start)
    const end = start + 12 + length
    const type = bytes.toString('ascii', start + 4, start + 8)
    if (type === 'IDAT') {
      dataIndex ??= parts.length
      if (parts.length !== dataIndex) return null
      idat.push(bytes.subarray(start + 8, end - 4))
    } else if (type === 'IHDR' || type === 'IEND' || ancillary.has(type)) {
      parts.push(bytes.subarray(start, end))
    } else return null
    start = end
  }
  const stride = info.width * 4 + 1
  const expected = stride * info.height
  const compressed = Buffer.concat(idat)
  let rows
  signal?.throwIfAborted()
  try {
    const decoded = inflateSync(compressed, { maxOutputLength: expected, info: true })
    if (decoded.buffer.length !== expected || decoded.engine.bytesWritten !== compressed.length) return null
    rows = decoded.buffer
  } catch { return null }
  // PNG predictors only compare samples of the same channel, so the filtered bytes can be reordered directly.
  for (let row = 0; row < expected; row += stride) {
    signal?.throwIfAborted()
    if (rows[row] > 4) return null
    for (let at = row + 1; at < row + stride; at += 4) {
      const blue = rows[at]
      rows[at] = rows[at + 2]
      rows[at + 2] = blue
    }
  }
  const output = deflateSync(rows)
  if (output.length > byteLimit) return null
  parts.splice(dataIndex, 0, pngChunk('IDAT', output))
  return Buffer.concat(parts)
}
