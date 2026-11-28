import {
  parseBulkDataHeader, parseMeshDescriptionUe4, resolveBulkDataPayload,
} from '@threenative/raw-unreal'
import { inflateSync } from 'node:zlib'
import { taggedProperties } from '../editor-package/properties.mjs'
import { requireLayout, skipUnrealString } from '../editor-package/tables.mjs'

const MiB = 1024 ** 2
function nativeSection(bytes, { start, end, nameAt }) {
  const tags = taggedProperties(bytes, start, end, nameAt)
  const models = tags.properties.get('SourceModels')
  const count = models?.type === 'ArrayProperty' && models.size >= 4 ? bytes.readInt32LE(models.start) : 0
  return { at: tags.end, count }
}

function boolean(bytes, offset, end) {
  requireLayout(offset + 4 <= end)
  const value = bytes.readInt32LE(offset)
  requireLayout(value === 0 || value === 1)
  return value === 1
}

function lodPayloads(bytes, mesh) {
  const { layout, end } = mesh
  const { at, count } = nativeSection(bytes, mesh)
  requireLayout(count > 0 && count <= 16)
  const flags = at + (boolean(bytes, at, end) ? 20 : 4)
  requireLayout(flags + 14 <= end && (bytes[flags] & 1) === 0 && !boolean(bytes, flags + 2, end))
  const sockets = skipUnrealString(bytes, flags + 14, end) + 20 // CRC and LightingGuid.
  requireLayout(sockets + 4 <= end)
  const socketCount = bytes.readInt32LE(sockets)
  requireLayout(socketCount >= 0 && socketCount <= 1024)
  let cursor = sockets + 4 + socketCount * 4
  let rawTotal = 0
  const payloads = []
  const missing = []
  for (let lod = 0; lod < count; lod++) {
    const valid = boolean(bytes, cursor, end)
    cursor += 4
    if (!valid) {
      missing.push(lod)
      continue
    }
    const header = parseBulkDataHeader(bytes, cursor, layout)
    const { file, storage, headerEnd, payloadOffset, sizeOnDisk, compression } = header
    const inline = storage === 'inline'
    const next = inline ? payloadOffset + sizeOnDisk : headerEnd
    requireLayout(file === 'uasset' && next + 20 <= end && sizeOnDisk > 0 &&
      (inline ? payloadOffset === headerEnd : payloadOffset >= layout.bulkDataStartOffset) &&
      payloadOffset + sizeOnDisk <= bytes.length)
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
  return { payloads, missing, cursor }
}

function materialSlots(bytes, mesh, cursor) {
  const { end, nameAt, imported } = mesh
  if (boolean(bytes, cursor, end)) return [] // Variable-length SpeedTree wind data.
  requireLayout(cursor + 8 <= end)
  const count = bytes.readInt32LE(cursor + 4)
  if (count < 0 || count > 128 || cursor + 8 + count * 44 !== end) return []
  return Array.from({ length: count }, (_, row) => {
    const at = cursor + 8 + row * 44
    const material = imported(bytes.readInt32LE(at))
    const outer = material && imported(material.outer)
    const path = outer?.type === 'Package' && outer.outer === 0 &&
      outer.name.startsWith('/Game/') && outer.name.endsWith('/' + material.name) ? outer.name : null
    return { name: nameAt(at + 4), imported: nameAt(at + 12), path }
  })
}

export function sourceMeshLods(bytes, mesh) {
  const { payloads, missing, cursor } = lodPayloads(bytes, mesh)
  const materials = materialSlots(bytes, mesh, cursor)
  return {
    materials,
    missing,
    *lods() {
      for (const { lod, header } of payloads) {
        const data = resolveBulkDataPayload(bytes, header, {
          zlib: (chunk, size) => inflateSync(chunk, { maxOutputLength: size }),
        })
        yield { lod, data: parseMeshDescriptionUe4(data) }
      }
    },
  }
}
