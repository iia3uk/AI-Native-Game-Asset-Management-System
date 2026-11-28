function nameRow(name) {
  const fields = Buffer.alloc(4 + name.length + 1 + 4)
  fields.writeInt32LE(name.length + 1)
  fields.write(name, 4, 'ascii')
  return fields
}

// Minimal stock UE4 table and export headers for exercising bounds and class checks.
export function sourceMeshHeaders() {
  const names = ['None', 'Class', 'StaticMesh', 'Package', '/Script/Engine', 'Fixture', 'SourceModels', 'ArrayProperty']
  const table = Buffer.concat(names.map(nameRow))
  const summary = Buffer.alloc(220)
  const imports = Buffer.alloc(2 * 36)
  const exports = Buffer.alloc(104)
  const serialized = Buffer.alloc(143)
  const bulk = Buffer.alloc(48)
  const importAt = summary.length + table.length
  const exportAt = importAt + imports.length
  const start = exportAt + exports.length

  summary.writeUInt32LE(0x9e2a83c1)
  summary.writeInt32LE(-7, 4)
  summary.writeInt32LE(864, 8)
  summary.writeInt32LE(522, 12)
  summary.writeInt32LE(1, 20)
  Buffer.from('ed68b0e4e94294f40bda31a241bb462e', 'hex').copy(summary, 24)
  summary.writeInt32LE(40, 40)
  summary.writeInt32LE(start, 44)
  summary.writeInt32LE(names.length, 56)
  summary.writeInt32LE(summary.length, 60)
  summary.writeInt32LE(1, 76)
  summary.writeInt32LE(exportAt, 80)
  summary.writeInt32LE(2, 84)
  summary.writeInt32LE(importAt, 88)
  summary.writeInt32LE(start, 92)
  summary.writeBigInt64LE(BigInt(start + serialized.length), 196)

  imports.writeInt32LE(1, 8)
  imports.writeInt32LE(-2, 16)
  imports.writeInt32LE(2, 20)
  imports.writeInt32LE(3, 36 + 8)
  imports.writeInt32LE(4, 36 + 20)
  exports.writeInt32LE(-1)
  exports.writeInt32LE(5, 16)
  exports.writeBigInt64LE(BigInt(serialized.length), 28)
  exports.writeBigInt64LE(BigInt(start), 36)

  serialized.writeInt32LE(6, 0)
  serialized.writeInt32LE(7, 8)
  serialized.writeInt32LE(4, 16)
  serialized.writeInt32LE(1, 33) // One SourceModel.
  serialized.writeInt32LE(1, 91) // Its serialized validity flag.
  serialized.writeInt32LE(3, 95) // Zlib-compressed end-of-file bulk.
  serialized.writeInt32LE(48, 99)
  serialized.writeInt32LE(48, 103)
  bulk.writeBigInt64LE(0x9e2a83c1n)
  bulk.writeBigInt64LE(131072n, 8)
  const bulkAt = start + serialized.length
  return { bytes: Buffer.concat([summary, table, imports, exports, serialized, bulk]),
    importAt, exportAt, start, bulkAt }
}
