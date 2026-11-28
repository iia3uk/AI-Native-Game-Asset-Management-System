import { parseBulkDataHeader, resolveBulkDataPayload } from '@threenative/raw-unreal'
import { inflateSync } from 'node:zlib'
import { importedGameObject } from '../editor-package/references.mjs'
import { requireLayout, skipUnrealString } from '../editor-package/tables.mjs'

const MiB = 1024 ** 2
const materialTypes = new Set(['Material', 'MaterialInstance', 'MaterialInstanceConstant'])

function boolean(bytes, offset, end) {
  requireLayout(offset + 4 <= end)
  const value = bytes.readInt32LE(offset)
  requireLayout(value === 0 || value === 1)
  return value === 1
}

function emptyRawHeader(bytes, cursor, end) {
  requireLayout(cursor + 20 <= end)
  const flags = bytes.readUInt32LE(cursor)
  const wide = (flags & 8192) !== 0
  if (wide) {
    requireLayout(cursor + 28 <= end)
    return bytes.readBigInt64LE(cursor + 4) === 0n && bytes.readBigInt64LE(cursor + 12) === 0n ? 28 : 0
  }
  return bytes.readInt32LE(cursor + 4) === 0 && bytes.readInt32LE(cursor + 8) === 0 ? 20 : 0
}

export function meshLodLayout(bytes, mesh, { flags, properties }, count, rawMesh = false) {
  const { layout, end } = mesh
  const models = properties.get('SourceModels')
  requireLayout(models?.type === 'ArrayProperty' && models.size >= 4 &&
    count > 0 && count <= 16 && bytes.readInt32LE(models.start) === count)
  const sockets = skipUnrealString(bytes, flags + 14, end) + 20 // CRC and LightingGuid.
  requireLayout(sockets + 4 <= end)
  const socketCount = bytes.readInt32LE(sockets)
  requireLayout(socketCount >= 0 && socketCount <= 1024)
  let cursor = sockets + 4 + socketCount * 4
  let rawTotal = 0
  const payloads = []
  const missing = []
  for (let lod = 0; lod < count; lod++) {
    if (rawMesh) {
      const empty = emptyRawHeader(bytes, cursor, end)
      if (empty) {
        boolean(bytes, cursor + empty + 16, end)
        cursor += empty + 20
        missing.push(lod)
        continue
      }
    } else {
      const valid = boolean(bytes, cursor, end)
      cursor += 4
      if (!valid) {
        missing.push(lod)
        continue
      }
    }
    const header = parseBulkDataHeader(bytes, cursor, layout)
    const { file, storage, headerEnd, payloadOffset, sizeOnDisk, compression } = header
    const inline = storage === 'inline'
    const next = inline ? payloadOffset + sizeOnDisk : headerEnd
    requireLayout(file === 'uasset' && next + 20 <= end && sizeOnDisk > 0 &&
      (inline ? payloadOffset === headerEnd : payloadOffset >= layout.bulkDataStartOffset) &&
      sizeOnDisk <= bytes.length - payloadOffset)
    boolean(bytes, next + 16, end)
    cursor = next + 20 // Bulk data GUID and bGuidIsHash.
    let raw = BigInt(sizeOnDisk)
    if (compression === 'zlib') {
      requireLayout(sizeOnDisk >= 48 && bytes.readBigInt64LE(payloadOffset + 8) >= 1024n)
      raw = bytes.readBigInt64LE(payloadOffset + 24)
    }
    requireLayout(raw > 0 && raw <= 48n * BigInt(MiB))
    rawTotal += Number(raw)
    requireLayout(rawTotal <= 64 * MiB)
    payloads.push({ lod, header })
  }
  return { payloads, missing, materials: materialSlots(bytes, mesh, cursor) }
}

function materialSlots(bytes, mesh, cursor) {
  const { end, nameAt, imported } = mesh
  if (boolean(bytes, cursor, end)) return [] // Variable-length SpeedTree wind data.
  requireLayout(cursor + 8 <= end)
  const count = bytes.readInt32LE(cursor + 4)
  if (count < 0 || count > 128 || cursor + 8 + count * 44 !== end) return []
  return Array.from({ length: count }, (_, row) => {
    const at = cursor + 8 + row * 44
    return { name: nameAt(at + 4), imported: nameAt(at + 12),
      path: importedGameObject(imported, bytes.readInt32LE(at), materialTypes) }
  })
}

export function meshLodPayload(bytes, header) {
  return resolveBulkDataPayload(bytes, header, {
    zlib: (chunk, size) => inflateSync(chunk, { maxOutputLength: size }),
  })
}
