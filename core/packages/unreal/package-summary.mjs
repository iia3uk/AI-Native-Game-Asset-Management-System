// Read the bounded prefix common to stock UE4/UE5 loose packages.
// See Epic's FPackageFileSummary and EPackageFlags documentation.
const packageMagic = 0x9e2a83c1
const cookedFlags = 0x80000200
const excludedEditorFlags = 0x00624010 // Script, disallow export, map data, map and compiled-in.
const savedHashVersion = 1016

function customVersionsEnd(bytes, offset, count, layout) {
  if (layout <= -6) return offset + count * 20
  for (let index = 0; index < count; index++) {
    offset += 20 // GUID and version, followed by the legacy display name.
    if (offset + 4 > bytes.length) return -1
    const length = bytes.readInt32LE(offset)
    const size = length < 0 ? -length * 2 : length
    if (size > 4096) return -1
    offset += 4 + size
  }
  return offset
}

export function unrealPackageSummary(bytes, size, { details = false } = {}) {
  if (bytes.length < 4 || bytes.readUInt32LE() !== packageMagic) return { storage: 'unknown', issue: 'unreal-package-signature' }
  if (bytes.length < 28) return { storage: 'unknown', issue: 'unreal-package-truncated' }
  const layout = bytes.readInt32LE(4)
  if (layout > -3 || layout < -9) return { storage: 'unknown', issue: 'unreal-package-layout' }
  const ue4 = bytes.readInt32LE(layout === -4 ? 8 : 12)
  const ue5 = layout <= -8 ? bytes.readInt32LE(16) : 0
  let offset = layout <= -8 ? 20 : layout === -4 ? 12 : 16
  const licensee = bytes.readInt32LE(offset)
  if (ue4 === 0 && ue5 === 0 && licensee === 0) return { storage: 'unversioned', layout, ue4, ue5 }
  const unsupported = { storage: 'unknown', issue: 'unreal-package-version', layout, ue4, ue5 }
  if (licensee || ue4 < 397 || ue4 > 522 || (ue5 !== 0 && (ue5 < 1000 || ue5 > 1018))) return unsupported
  offset += 4
  let headerSize
  if (ue5 >= savedHashVersion) {
    if (bytes.length < offset + 28) return { storage: 'unknown', issue: 'unreal-package-truncated' }
    offset += 20
    headerSize = bytes.readInt32LE(offset)
    offset += 4
  }
  const customCount = bytes.readInt32LE(offset)
  offset += 4
  if (customCount < 0 || customCount > 2048) return { storage: 'unknown', issue: 'unreal-package-custom-versions' }
  offset = customVersionsEnd(bytes, offset, customCount, layout)
  const invalid = { storage: 'unknown', issue: 'unreal-package-summary', layout, ue4, ue5 }
  if (offset < 0 || offset + 8 > bytes.length) return invalid
  if (headerSize === undefined) {
    headerSize = bytes.readInt32LE(offset)
    offset += 4
  }
  const nameLength = bytes.readInt32LE(offset)
  offset += 4
  const nameSize = nameLength < 0 ? -nameLength * 2 : nameLength
  if (nameSize > 4096) return invalid
  offset += nameSize
  if (offset + 12 > bytes.length || headerSize < offset + 12 || headerSize > size) return invalid
  const flags = bytes.readUInt32LE(offset)
  const nameCount = bytes.readInt32LE(offset + 4)
  const nameOffset = bytes.readInt32LE(offset + 8)
  if (nameCount < 0 || nameOffset < 0 || (nameCount && (nameOffset < offset + 12 || nameOffset >= headerSize))) return invalid
  return {
    storage: flags & cookedFlags ? 'cooked' : 'editor',
    layout, ue4, ue5, ...(details && { headerSize, nameOffset }),
    ...(flags & excludedEditorFlags && { issue: 'unreal-package-editor-excluded' }),
  }
}
