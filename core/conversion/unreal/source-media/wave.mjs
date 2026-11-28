export const waveMagic = Buffer.from('RIFF')

export function embeddedWave(bytes, start) {
  if (start + 44 > bytes.length || bytes.toString('ascii', start + 8, start + 12) !== 'WAVE') return null
  const end = start + 8 + bytes.readUInt32LE(start + 4)
  if (end > bytes.length || end < start + 44) return null
  let format
  let dataSize
  let cursor = start + 12
  for (let count = 0; cursor + 8 <= end && count < 128; count++) {
    const type = bytes.toString('ascii', cursor, cursor + 4)
    const size = bytes.readUInt32LE(cursor + 4)
    const offset = cursor + 8
    cursor = offset + size + (size & 1)
    if (cursor > end) return null
    if (type === 'fmt ') {
      if (format || size < 16 || size > 64 || bytes.readUInt16LE(offset) !== 1) return null
      const channels = bytes.readUInt16LE(offset + 2)
      const sampleRate = bytes.readUInt32LE(offset + 4)
      const byteRate = bytes.readUInt32LE(offset + 8)
      const frameSize = bytes.readUInt16LE(offset + 12)
      const bits = bytes.readUInt16LE(offset + 14)
      if (!channels || channels > 8 || sampleRate < 8000 || sampleRate > 192000 ||
          ![8, 16, 24, 32].includes(bits) || frameSize !== channels * bits / 8 || byteRate !== sampleRate * frameSize) return null
      format = { channels, sampleRate, frameSize, bits }
    } else if (type === 'data') {
      if (!format || dataSize !== undefined) return null
      dataSize = size
    }
  }
  if (cursor !== end || !format || !dataSize || dataSize % format.frameSize !== 0) return null
  const { frameSize, ...metadata } = format
  return { end, audio: { ...metadata, frames: dataSize / frameSize } }
}
