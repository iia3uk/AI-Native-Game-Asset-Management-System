const tocMagic = Buffer.from('-==--==--==--==-')
const pakMagic = Buffer.from([0xe1, 0x12, 0x6f, 0x5a])

export function ioStoreHeader(bytes, size) {
  if (bytes.length < 144 || !bytes.subarray(0, 16).equals(tocMagic)) return null
  const version = bytes[16]
  const headerSize = bytes.readUInt32LE(20)
  if (!version || headerSize < 144 || headerSize > size) return null
  return { version, flags: bytes[80], encrypted: Boolean(bytes[80] & 2), chunks: bytes.readUInt32LE(24) }
}

export function pakFooter(bytes, size) {
  // Standard trailer magic is preceded by the index-encryption flag in recent versions.
  for (let at = bytes.lastIndexOf(pakMagic); at >= 0; at = at ? bytes.lastIndexOf(pakMagic, at - 1) : -1) {
    if (bytes.length - at < 44) continue
    const version = bytes.readInt32LE(at + 4)
    if (version < 1 || version > 15 || (version >= 4 && (at < 1 || bytes[at - 1] > 1))) continue
    const start = bytes.readBigInt64LE(at + 8)
    const length = bytes.readBigInt64LE(at + 16)
    if (start < 0n || length <= 0n || start + length > BigInt(size - bytes.length + at)) continue
    return { version, encryptedIndex: version >= 4 && bytes[at - 1] === 1 }
  }
  return null
}
