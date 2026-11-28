import { BULK_DATA_FLAG, parseBulkDataHeader, UAssetError } from '@threenative/raw-unreal'
import { editorPackage } from '../editor-package/tables.mjs'
import { taggedProperties } from '../editor-package/properties.mjs'
import { legacyTexturePackage } from './legacy-tables.mjs'

const textureClass = new Set(['Texture2D'])
const { PAYLOAD_AT_END_OF_FILE: atEndOfFile, SERIALIZE_COMPRESSED_ZLIB: compressedZlib } = BULK_DATA_FLAG

function integer(bytes, field) {
  return field?.type === 'IntProperty' && field.size === 4 ? bytes.readInt32LE(field.start) : null
}

function sourcePayload(bytes, table, texture, start, end) {
  if (start + 4 > texture.end) return null
  const hasGuid = bytes.readUInt32LE(start)
  if (hasGuid > 1) return null
  const strip = start + 4 + 16 * hasGuid
  const at = strip + 2
  if (at + 20 > texture.end || bytes[strip] !== 0 || bytes[strip + 1] !== 0) return null

  const flags = bytes.readUInt32LE(at)
  if (flags !== atEndOfFile && flags !== (atEndOfFile | compressedZlib)) return null
  const { payloadOffset, sizeOnDisk, elementCount } = parseBulkDataHeader(bytes, at, table.layout)
  if (payloadOffset < texture.end || sizeOnDisk > end - payloadOffset) return null
  return { start: payloadOffset, end: payloadOffset + sizeOnDisk, length: elementCount, zlib: !!(flags & compressedZlib) }
}

function textureProperties(bytes, version) {
  let texture
  try {
    const table = version < 514 ? legacyTexturePackage(bytes, version) : editorPackage(bytes, version)
    texture = table?.topLevel(textureClass)
    if (!texture) return undefined
    return { table, texture, tags: taggedProperties(bytes, texture.start, texture.end, table.nameAt, version) }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return texture ? null : undefined
  }
}

// Undefined means that the source art metadata was unavailable to the stock table reader.
export function texturePngSource(bytes, version, end) {
  const object = textureProperties(bytes, version)
  if (!object) return object
  const source = object.tags.properties.get('Source')
  if (!source) return undefined
  if (source.type !== 'StructProperty' || source.inner !== 'TextureSource') return null
  const { table, texture, tags } = object
  try {
    const fields = taggedProperties(bytes, source.start, source.end, table.nameAt, version)
    const png = fields.properties.get('bPNGCompressed')
    const format = fields.properties.get('Format')
    if (fields.end !== source.end || png?.type !== 'BoolProperty' || png.size !== 0 || png.value !== 1 ||
        format?.type !== 'ByteProperty' || format.inner !== 'ETextureSourceFormat' || format.size !== 8) return null
    const sourceFormat = table.nameAt(format.start)
    const width = integer(bytes, fields.properties.get('SizeX'))
    const height = integer(bytes, fields.properties.get('SizeY'))
    if (!(width > 0 && height > 0) || integer(bytes, fields.properties.get('NumSlices')) !== 1 ||
        integer(bytes, fields.properties.get('NumMips')) !== 1) return null
    const layers = fields.properties.get('LayerFormat')
    if (layers && (layers.type !== 'ArrayProperty' || layers.inner !== 'ByteProperty' || layers.size !== 12 ||
        bytes.readInt32LE(layers.start) !== 1 || table.nameAt(layers.start + 4) !== sourceFormat)) return null
    const blocks = fields.properties.get('Blocks')
    if (blocks && (blocks.type !== 'ArrayProperty' || blocks.size !== 4 || bytes.readInt32LE(blocks.start) !== 0)) return null
    const payload = sourcePayload(bytes, table, texture, tags.end, end)
    return payload && { ...payload, sourceFormat, width, height }
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof UAssetError)) throw error
    return null
  }
}
