export const unrealExportStride = 104

export const requireLayout = (condition) => {
  if (!condition) throw new RangeError('Unsupported or invalid Unreal package layout')
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

function readNames(bytes, layout, end, nameHashBytes) {
  const names = []
  let at = layout.nameOffset
  for (let i = 0; i < layout.nameCount; i++) {
    const [name, next] = stringAt(bytes, at, end)
    at = next + nameHashBytes
    requireLayout(at <= end)
    names.push(name)
  }
  return names
}

export function unrealObjectTables(bytes, { layout, importOffset, importCount, importStride, exportDataEnd,
  exportStride = unrealExportStride, nameHashBytes = 4, legacyExports = false }) {
  const { exportCount, exportOffset, totalHeaderSize } = layout
  const names = readNames(bytes, layout, importOffset, nameHashBytes)
  const outerOffset = legacyExports ? 8 : 12
  function nameAt(at, data = bytes) {
    const name = names[data.readInt32LE(at)]
    const number = data.readInt32LE(at + 4)
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
    const size = legacyExports ? bytes.readInt32LE(at + 24) : Number(bytes.readBigInt64LE(at + 28))
    const start = legacyExports ? bytes.readInt32LE(at + 28) : Number(bytes.readBigInt64LE(at + 36))
    requireLayout(Number.isSafeInteger(start) && Number.isSafeInteger(size) && start >= totalHeaderSize &&
      size > 0 && size <= exportDataEnd - start)
    return { index, type: type.name, outer: bytes.readInt32LE(at + outerOffset),
      start, end: start + size, name: nameAt(at + outerOffset + 4) }
  }
  function topLevel(types) {
    const matches = []
    for (let index = 1; index <= exportCount; index++) {
      const at = exportOffset + (index - 1) * exportStride
      if (bytes.readInt32LE(at + outerOffset) !== 0 || !types.has(imported(bytes.readInt32LE(at))?.name)) continue
      const object = exported(index)
      if (object) matches.push(object)
    }
    requireLayout(matches.length <= 1)
    return matches[0] ?? null
  }
  return { layout, nameAt, imported, exported, topLevel }
}
