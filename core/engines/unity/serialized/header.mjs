const unityVersion = /^\d{1,4}\.\d{1,3}\.\d{1,4}[abfp]\d{1,4}$/
export const serializedProbeSize = 72
export const isSerializedVersion = version => version === 22 || version === 23

export function isSerializedUnity(prefix, size) {
  const headerSize = 48
  if (prefix.length < headerSize || !isSerializedVersion(prefix.readUInt32BE(8)) || prefix[16] !== 0) return false
  const metadataSize = prefix.readUInt32BE(20)
  const offset = prefix.readBigUInt64BE(32)
  if (prefix.readBigUInt64BE(24) !== BigInt(size) || offset > BigInt(size) ||
      metadataSize > 32 * 1024 ** 2 || BigInt(headerSize + metadataSize) > offset) return false
  const metadata = prefix.subarray(headerSize, headerSize + metadataSize)
  const end = metadata.indexOf(0)
  return end > 0 && unityVersion.test(metadata.toString('latin1', 0, end))
}
