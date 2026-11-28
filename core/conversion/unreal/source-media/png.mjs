import { crc32 } from 'node:zlib'

export const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex')
const pngDepths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]])

export function embeddedPng(bytes, start) {
  if (!bytes.subarray(start, start + 8).equals(pngMagic)) return null
  let cursor = start + 8
  let dimensions
  let imageData = false
  for (let index = 0; index < 8192 && cursor + 12 <= bytes.length; index++) {
    const size = bytes.readUInt32BE(cursor)
    const type = bytes.toString('ascii', cursor + 4, cursor + 8)
    const data = cursor + 8
    const end = data + size
    if (end + 4 > bytes.length || !/^[A-Za-z]{4}$/.test(type) ||
        crc32(bytes.subarray(cursor + 4, end)) !== bytes.readUInt32BE(end)) return null
    if (index === 0) {
      if (type !== 'IHDR' || size !== 13) return null
      const width = bytes.readUInt32BE(data)
      const height = bytes.readUInt32BE(data + 4)
      const depths = pngDepths.get(bytes[data + 9])
      if (!width || !height || width > 8192 || height > 8192 || width * height > 32 * 1024 ** 2 ||
          !depths?.includes(bytes[data + 8]) || bytes[data + 10] || bytes[data + 11] || bytes[data + 12] > 1) return null
      dimensions = { width, height }
    } else if (type === 'IDAT') {
      imageData ||= size > 0
    } else if (type === 'IEND') {
      return size === 0 && imageData ? { end: end + 4, ...dimensions } : null
    } else if (type === 'IHDR') return null
    cursor = end + 4
  }
  return null
}
