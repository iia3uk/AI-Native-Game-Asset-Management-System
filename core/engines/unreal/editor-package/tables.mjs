import { readPackageLayout } from '@threenative/raw-unreal'

import { requireLayout, skipUnrealString, unrealExportStride, unrealObjectTables } from '../package-tables.mjs'

export { requireLayout, skipUnrealString } from '../package-tables.mjs'

const editorLayouts = new Map([
  [514, { editorVersion: 20, importStride: 28, localizationId: false }],
  [518, { editorVersion: 37, importStride: 28, localizationId: true }],
  [522, { editorVersion: 40, importStride: 36, localizationId: true }],
])

// These stock UE4 editor layouts use fixed-width import/export entries and inline export data.
export function editorPackage(bytes, version = 522) {
  const layout = readPackageLayout(bytes)
  const schema = editorLayouts.get(version)
  if (!schema || !layout || layout.legacyFileVersion !== -7 || layout.fileVersionUE4 !== version ||
      layout.licenseeVersion !== 0 || layout.editorObjectVersion !== schema.editorVersion) return null
  const { importStride } = schema
  const { totalHeaderSize, bulkDataStartOffset, exportCount, exportOffset, nameOffset, nameCount } = layout
  requireLayout(exportCount <= 4096 && nameCount <= 32_768)
  const folderEnd = skipUnrealString(bytes, 28 + bytes.readInt32LE(20) * 20, nameOffset)
  const localStart = folderEnd + 12
  const localEnd = schema.localizationId ? skipUnrealString(bytes, localStart, nameOffset) : localStart
  requireLayout(localEnd + 28 <= nameOffset && (bytes.readUInt32LE(folderEnd) & 0x80000200) === 0)
  const importCount = bytes.readInt32LE(localEnd + 16)
  const importOffset = bytes.readInt32LE(localEnd + 20)
  const dependsOffset = bytes.readInt32LE(localEnd + 24)
  requireLayout(importCount >= 0 && importCount <= 8192 && importOffset > nameOffset &&
    importOffset + importCount * importStride === exportOffset &&
    exportOffset + exportCount * unrealExportStride === dependsOffset && dependsOffset <= totalHeaderSize)
  return unrealObjectTables(bytes, { layout, importOffset, importCount, importStride,
    exportDataEnd: Math.min(bulkDataStartOffset, bytes.length) })
}
