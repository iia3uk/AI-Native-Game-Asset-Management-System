import { readPackageLayout } from '@threenative/raw-unreal'

const importStride = 36
const exportStride = 104

export const requireLayout = (condition) => {
  if (!condition) throw new RangeError('Unsupported or invalid Unreal editor package layout')
}

function stringAt(bytes, at, end) {
  requireLayout(at + 4 <= end)
  const length = bytes.readInt32LE(at)
  const width = length < 0 ? 2 : 1
  const size = Math.abs(length) * width
  const next = at + 4 + size
  requireLayout(size <= 4096 && next <= end &&
    (!size || bytes.subarray(next - width, next).every(byte => byte === 0)))
  return [size ? bytes.toString(width === 2 ? 'utf16le' : 'utf8', at + 4, next - width) : '', next]
}

export function skipUnrealString(bytes, at, end) {
  return stringAt(bytes, at, end)[1]
}

function readNames(bytes, layout, end) {
  const names = []
  let at = layout.nameOffset
  for (let i = 0; i < layout.nameCount; i++) {
    const [name, next] = stringAt(bytes, at, end)
    at = next + 4 // Case-preserving and case-insensitive hashes.
    requireLayout(at <= end)
    names.push(name)
  }
  return names
}

// Stock UE4 522 editor packages use fixed-width import/export entries and inline export data.
export function editorPackage(bytes) {
  const layout = readPackageLayout(bytes)
  if (!layout || layout.legacyFileVersion !== -7 || layout.fileVersionUE4 !== 522 ||
      layout.licenseeVersion !== 0 || layout.editorObjectVersion !== 40) return null
  const { totalHeaderSize, bulkDataStartOffset, exportCount, exportOffset, nameOffset, nameCount } = layout
  requireLayout(exportCount <= 4096 && nameCount <= 32_768)
  const folderEnd = skipUnrealString(bytes, 28 + bytes.readInt32LE(20) * 20, nameOffset)
  const localEnd = skipUnrealString(bytes, folderEnd + 12, nameOffset)
  requireLayout(localEnd + 28 <= nameOffset && (bytes.readUInt32LE(folderEnd) & 0x80000200) === 0)
  const importCount = bytes.readInt32LE(localEnd + 16)
  const importOffset = bytes.readInt32LE(localEnd + 20)
  const dependsOffset = bytes.readInt32LE(localEnd + 24)
  requireLayout(importCount >= 0 && importCount <= 8192 && importOffset > nameOffset &&
    importOffset + importCount * importStride === exportOffset &&
    exportOffset + exportCount * exportStride === dependsOffset && dependsOffset <= totalHeaderSize)
  const names = readNames(bytes, layout, importOffset)
  function nameAt(at) {
    const name = names[bytes.readInt32LE(at)]
    const number = bytes.readInt32LE(at + 4)
    requireLayout(name !== undefined && number >= 0)
    return number ? name + '_' + (number - 1) : name
  }
  function imported(index) {
    const row = -1 - index
    if (row < 0 || row >= importCount) return null
    const at = importOffset + row * importStride
    return { type: nameAt(at + 8), outer: bytes.readInt32LE(at + 16), name: nameAt(at + 20) }
  }
  function exported(index) {
    const row = index - 1
    if (row < 0 || row >= exportCount) return null
    const at = exportOffset + row * exportStride
    const type = imported(bytes.readInt32LE(at))
    const owner = type?.type === 'Class' && imported(type.outer)
    if (owner?.type !== 'Package' || owner.name !== '/Script/Engine' || owner.outer !== 0) return null
    const size = Number(bytes.readBigInt64LE(at + 28))
    const start = Number(bytes.readBigInt64LE(at + 36))
    requireLayout(start >= totalHeaderSize && size > 0 && start + size <= bulkDataStartOffset &&
      start + size <= bytes.length)
    return { index, type: type.name, outer: bytes.readInt32LE(at + 12), start, end: start + size, name: nameAt(at + 16) }
  }
  function topLevel(types) {
    const matches = []
    for (let index = 1; index <= exportCount; index++) {
      const at = exportOffset + (index - 1) * exportStride
      if (bytes.readInt32LE(at + 12) !== 0 || !types.has(imported(bytes.readInt32LE(at))?.name)) continue
      const object = exported(index)
      if (object) matches.push(object)
    }
    requireLayout(matches.length <= 1)
    return matches[0] ?? null
  }
  return { layout, nameAt, imported, exported, topLevel }
}
