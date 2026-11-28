const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value << 24
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0)
  return crc >>> 0
})
const vorbis = Buffer.from('vorbis')

export function oggVorbis(bytes, signal) {
  let at = 0
  let pages = 0
  let packets = 0
  let serial
  let continued = false
  let packetSize = 0
  const prefix = Buffer.alloc(30)
  let channels, sampleRate
  while (at + 27 <= bytes.length && pages < 65536) {
    signal?.throwIfAborted()
    const flags = bytes[at + 5]
    const segments = bytes[at + 26]
    const body = at + 27 + segments
    if (bytes.toString('ascii', at, at + 4) !== 'OggS' || bytes[at + 4] !== 0 || (flags & ~7) ||
        Boolean(flags & 1) !== continued || Boolean(flags & 2) !== (pages === 0) || !segments || body > bytes.length ||
        bytes.readUInt32LE(at + 18) !== pages) return null
    serial ??= bytes.readUInt32LE(at + 14)
    if (bytes.readUInt32LE(at + 14) !== serial) return null
    let end = body
    for (let index = at + 27; index < body; index++) end += bytes[index]
    if (end > bytes.length || !validPageCrc(bytes, at, end)) return null
    let data = body
    for (let index = at + 27; index < body; index++) {
      const length = bytes[index]
      if (packets <= 2 && packetSize < prefix.length) {
        bytes.copy(prefix, packetSize, data, data + Math.min(length, prefix.length - packetSize))
      }
      data += length
      packetSize += length
      continued = length === 255
      if (continued) continue
      if (packets <= 2 && (packetSize < 7 || prefix[0] !== [1, 3, 5][packets] ||
          !prefix.subarray(1, 7).equals(vorbis))) return null
      if (packets === 0) {
        channels = prefix[11]
        sampleRate = prefix.readUInt32LE(12)
        const short = prefix[28] & 15
        const long = prefix[28] >> 4
        if (packetSize !== 30 || prefix.readUInt32LE(7) !== 0 || channels < 1 || channels > 8 ||
            sampleRate < 8000 || sampleRate > 192000 || short < 6 || long > 13 || short > long || prefix[29] !== 1) return null
      }
      packets++
      packetSize = 0
    }
    if (pages === 0 && (packets !== 1 || continued)) return null
    if (flags & 4) {
      const frames = Number(bytes.readBigInt64LE(at + 6))
      return end === bytes.length && !continued && packets >= 4 && Number.isSafeInteger(frames) && frames > 0
        ? { channels, sampleRate, frames } : null
    }
    at = end
    pages++
  }
  return null
}

function validPageCrc(bytes, start, end) {
  let crc = 0
  const checksum = start + 22
  for (let index = start; index < end; index++) {
    const value = index >= checksum && index < checksum + 4 ? 0 : bytes[index]
    crc = (crc << 8) ^ crcTable[(crc >>> 24) ^ value]
  }
  return (crc >>> 0) === bytes.readUInt32LE(checksum)
}
