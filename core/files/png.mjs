import { crc32, deflateSync } from 'node:zlib'

export function pngChunk(type, data) {
  const result = Buffer.alloc(12 + data.length)
  result.writeUInt32BE(data.length)
  result.write(type, 4, 4, 'ascii')
  data.copy(result, 8)
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4)
  return result
}

export function encodePngScanlines(width, height, pixels, { alpha = false, linear = false, srgb = false } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header.set([8, alpha ? 6 : 2], 8)
  const gamma = []
  if (linear) {
    const value = Buffer.alloc(4)
    value.writeUInt32BE(100_000)
    gamma.push(pngChunk('gAMA', value))
  } else if (srgb) gamma.push(pngChunk('sRGB', Buffer.from([0])))
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), ...gamma,
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))])
}
