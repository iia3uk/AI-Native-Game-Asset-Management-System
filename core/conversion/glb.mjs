export function encodeGlb(document, buffers, binarySize) {
  const json = Buffer.from(JSON.stringify(document))
  const jsonSize = Math.ceil(json.length / 4) * 4
  const total = 28 + jsonSize + binarySize
  const result = Buffer.allocUnsafeSlow(total)
  result.write('glTF', 0, 'ascii')
  result.writeUInt32LE(2, 4)
  result.writeUInt32LE(total, 8)
  result.writeUInt32LE(jsonSize, 12)
  result.write('JSON', 16, 'ascii')
  json.copy(result, 20)
  result.fill(0x20, 20 + json.length, 20 + jsonSize)
  result.writeUInt32LE(binarySize, 20 + jsonSize)
  result.write('BIN\0', 24 + jsonSize, 'ascii')
  let at = 28 + jsonSize
  for (const bytes of buffers) {
    if (bytes.length > total - at) throw new RangeError('GLB buffer parts exceed the declared size')
    at += bytes.copy(result, at)
  }
  if (at !== total) throw new RangeError('GLB buffer parts do not match the declared size')
  return result
}
