import { inflateSync } from 'node:zlib'

export const bulkMagic = Buffer.from('c1832a9e000000000000020000000000', 'hex')
const chunkSize = 128 * 1024
const byteLimit = 64 * 1024 ** 2

export function inflateSourceChunks(bytes, start, end, signal) {
  if (start + 48 > end || !bytes.subarray(start, start + 16).equals(bulkMagic)) return null
  const compressed = bytes.readBigUInt64LE(start + 16)
  const plain = bytes.readBigUInt64LE(start + 24)
  if (!plain || plain > BigInt(byteLimit) || !compressed || compressed > BigInt(end - start)) return null
  const outputSize = Number(plain)
  const count = Math.ceil(outputSize / chunkSize)
  let cursor = start + 32 + 16 * count
  if (cursor + Number(compressed) !== end) return null
  const decoded = Buffer.allocUnsafe(outputSize)
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted()
    const row = start + 32 + index * 16
    const length = bytes.readBigUInt64LE(row)
    const position = index * chunkSize
    const expected = Math.min(chunkSize, outputSize - position)
    if (!length || length > BigInt(end - cursor) || bytes.readBigUInt64LE(row + 8) !== BigInt(expected)) return null
    const next = cursor + Number(length)
    try {
      const { engine, buffer } = inflateSync(bytes.subarray(cursor, next), { maxOutputLength: expected, info: true })
      if (buffer.length !== expected || engine.bytesWritten !== Number(length)) return null
      buffer.copy(decoded, position)
    } catch { return null }
    cursor = next
  }
  return cursor === end ? decoded : null
}
