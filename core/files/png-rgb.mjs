import { inflateSync } from 'node:zlib'
import { embeddedPng } from './png-structure.mjs'

const bytesPerPixel = new Map([[2, 3], [6, 4]])
const grayscale = new Map([[0, 1], [4, 2]])
const pixelLimit = 16 * 1024 ** 2

function paeth(left, above, corner) {
  const estimate = left + above - corner
  const a = Math.abs(estimate - left)
  const b = Math.abs(estimate - above)
  const c = Math.abs(estimate - corner)
  if (a <= b && a <= c) return left
  return b <= c ? above : corner
}

export function readPngRgb(bytes, signal) {
  return readPixels(bytes, bytesPerPixel.get(bytes[25]), signal)
}

export function readPngPixels(bytes, signal) {
  return readPixels(bytes, bytesPerPixel.get(bytes[25]) ?? grayscale.get(bytes[25]), signal)
}

function readPixels(bytes, channels, signal) {
  const info = embeddedPng(bytes, 0)
  if (!info || info.end !== bytes.length || !channels || bytes[24] !== 8 || bytes[28] !== 0 ||
      info.width * info.height > pixelLimit) return null
  const idat = []
  for (let start = 8; start < bytes.length;) {
    const length = bytes.readUInt32BE(start)
    if (bytes.toString('ascii', start + 4, start + 8) === 'IDAT') idat.push(bytes.subarray(start + 8, start + 8 + length))
    start += 12 + length
  }
  const { width, height } = info
  const rowBytes = width * channels + 1
  const expected = rowBytes * height
  let rows
  signal?.throwIfAborted()
  try { rows = inflateSync(Buffer.concat(idat), { maxOutputLength: expected }) } catch { return null }
  if (rows.length !== expected) return null
  for (let y = 0; y < height; y++) {
    signal?.throwIfAborted()
    const start = y * rowBytes
    const filter = rows[start]
    if (filter > 4) return null
    if (filter === 0) continue
    for (let x = 1; x < rowBytes; x++) {
      const at = start + x
      const left = x > channels ? rows[at - channels] : 0
      const above = y > 0 ? rows[at - rowBytes] : 0
      const corner = y > 0 && x > channels ? rows[at - rowBytes - channels] : 0
      const offset = filter === 1 ? left : filter === 2 ? above :
        filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, corner)
      rows[at] = (rows[at] + offset) & 255
    }
    rows[start] = 0
  }
  return { width, height, channels, rows, rowBytes }
}
