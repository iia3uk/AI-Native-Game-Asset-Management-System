import { requireLayout, skipUnrealString, unrealExportStride, unrealObjectTables } from '../package-tables.mjs'

export const maxCookedHeader = 16 * 1024 ** 2
const maxFile = 128 * 1024 ** 2
const importStride = 28

export function cookedHeaderSize(bytes, fileSize) {
  if (bytes.length < 24 || bytes.readUInt32LE() !== 0x9e2a83c1 || bytes.readInt32LE(4) !== -7 ||
      bytes.readInt32LE(12) !== 522 || bytes.readInt32LE(16) !== 0) return null
  const count = bytes.readInt32LE(20)
  if (count < 0 || count > 256) return null
  const at = 24 + count * 20
  if (bytes.length < at + 4) return null
  const size = bytes.readInt32LE(at)
  return size >= at + 48 && size <= Math.min(maxCookedHeader, fileSize) ? size : null
}

export function cookedPackage(bytes) {
  const totalHeaderSize = cookedHeaderSize(bytes, bytes.length)
  if (totalHeaderSize !== bytes.length) return null
  const summary = 24 + bytes.readInt32LE(20) * 20
  const fields = skipUnrealString(bytes, summary + 4, totalHeaderSize)
  requireLayout(fields + 40 <= totalHeaderSize)
  const flags = bytes.readUInt32LE(fields)
  if (((flags & 0x80002200) >>> 0) !== 0x80000200) return null
  const nameCount = bytes.readInt32LE(fields + 4)
  const nameOffset = bytes.readInt32LE(fields + 8)
  const exportCount = bytes.readInt32LE(fields + 20)
  const exportOffset = bytes.readInt32LE(fields + 24)
  const importCount = bytes.readInt32LE(fields + 28)
  const importOffset = bytes.readInt32LE(fields + 32)
  const dependsOffset = bytes.readInt32LE(fields + 36)
  requireLayout(nameCount > 0 && nameCount <= 32768 && exportCount > 0 && exportCount <= 4096 &&
    importCount > 0 && importCount <= 8192 && nameOffset >= fields + 40 && importOffset - nameOffset >= nameCount * 8 &&
    importOffset + importCount * importStride === exportOffset && exportOffset + exportCount * unrealExportStride <= totalHeaderSize &&
    (dependsOffset === 0 || (dependsOffset >= exportOffset + exportCount * unrealExportStride && dependsOffset <= totalHeaderSize)))
  const layout = { fileVersionUE4: 522, totalHeaderSize, nameOffset, nameCount, exportOffset, exportCount }
  return { ...unrealObjectTables(bytes, { layout, importOffset, importCount, importStride, exportDataEnd: totalHeaderSize + maxFile }),
    summaryBytes: bytes.subarray(0, summary) }
}
