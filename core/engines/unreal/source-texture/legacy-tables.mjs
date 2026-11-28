import { readPackageLayout } from '@threenative/raw-unreal'
import { requireLayout, skipUnrealString, unrealObjectTables } from '../package-tables.mjs'

const schemas = new Map([
  [397, { legacy: -3, exportStride: 68, nameHashBytes: 0 }],
  [449, { legacy: -5, exportStride: 68, nameHashBytes: 0 }],
  [506, { legacy: -6, exportStride: 72, nameHashBytes: 4 }],
])

export function legacyTexturePackage(bytes, version) {
  const schema = schemas.get(version)
  if (!schema) return null
  const layout = readPackageLayout(bytes)
  if (!layout || layout.fileVersionUE4 !== version || layout.licenseeVersion !== 0 ||
      layout.legacyFileVersion !== schema.legacy) return null

  const { nameOffset, nameCount, exportOffset, exportCount, totalHeaderSize, bulkDataStartOffset } = layout
  requireLayout(exportCount <= 4096 && nameCount <= 32_768)
  const customCount = bytes.readInt32LE(20)
  if (version !== 506 && customCount !== 0) return null
  const flagsAt = skipUnrealString(bytes, 28 + customCount * 20, nameOffset)
  const exportsAt = flagsAt + (version === 506 ? 20 : 12) // 506 includes the gatherable text fields.
  requireLayout(exportsAt + 20 <= nameOffset && (bytes.readUInt32LE(flagsAt) & 0x80000200) === 0)
  requireLayout(bytes.readInt32LE(flagsAt + 4) === nameCount && bytes.readInt32LE(flagsAt + 8) === nameOffset &&
    bytes.readInt32LE(exportsAt) === exportCount && bytes.readInt32LE(exportsAt + 4) === exportOffset)
  const importCount = bytes.readInt32LE(exportsAt + 8)
  const importOffset = bytes.readInt32LE(exportsAt + 12)
  const dependsOffset = bytes.readInt32LE(exportsAt + 16)
  const importStride = 28
  requireLayout(importCount >= 0 && importCount <= 8192 && importOffset > nameOffset &&
    importOffset + importCount * importStride === exportOffset &&
    exportOffset + exportCount * schema.exportStride === dependsOffset && dependsOffset <= totalHeaderSize)
  return unrealObjectTables(bytes, { layout, importOffset, importCount, importStride,
    exportDataEnd: Math.min(bulkDataStartOffset, bytes.length), exportStride: schema.exportStride,
    nameHashBytes: schema.nameHashBytes, legacyExports: true })
}
