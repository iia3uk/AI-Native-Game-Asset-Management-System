export const words = (...values) => {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4))
  return bytes
}

export const long = value => {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(BigInt(value))
  return bytes
}

const nil = 0xffffffffffffffffn
export const zenFixtureId = 0x0cdfc36a01bb2f9dn
export const zenFixtureName = '/Game/Verification/Sample'
export const zenName = (names, name) => words(names.indexOf(name), 0)

function nameBatch(names) {
  if (!names.length) return words(0)
  const strings = names.map(value => Buffer.from(value))
  const stringBytes = Buffer.concat(strings)
  return Buffer.concat([words(names.length, stringBytes.length), long(0xc1640000),
    Buffer.alloc(8 * names.length), Buffer.from(strings.flatMap(string => [0, string.length])), stringBytes])
}

export function zenPackage({ ue54, names, classId, bulkMap, object, label = 'Sample', publicHash = 0,
  importedNames = [], importedHashes = [], importedObjects = [] }) {
  const nameMap = nameBatch(names)
  const version = words(3, 522, ue54 ? 1012 : 1009, 0, 0)
  const pad = (8 - (52 + version.length + nameMap.length) % 8) % 8
  const bulkHeader = Buffer.concat([...(ue54 ? [long(pad), Buffer.alloc(pad)] : []), long(bulkMap.length), bulkMap])
  const imports = 52 + version.length + nameMap.length + bulkHeader.length
  const importMap = imports + importedHashes.length * 8
  const exportAt = importMap + (1 + importedObjects.length) * 8
  const exportTable = Buffer.concat([long(0), long(object.length), zenName(names, label), long(nil), long(classId),
    long(nil), long(nil), long(publicHash), words(3, 0)])
  const bundles = exportAt + exportTable.length
  const dependencies = bundles + 16
  const packageNames = dependencies + 20
  const packageNameTable = Buffer.concat([nameBatch(importedNames), Buffer.alloc(importedNames.length * 4)])
  const end = packageNames + packageNameTable.length
  const header = words(1, end, 0, 0, 0x80000200, end, imports, importMap, exportAt, bundles, dependencies, packageNames, packageNames)
  return Buffer.concat([header, version, nameMap, bulkHeader, ...importedHashes.map(long), long(classId),
    ...importedObjects.map(long), exportTable, words(0, 0, 0, 1), words(0xffffffff, 0, 0, 0, 0),
    packageNameTable, object])
}
