import { editorPackage } from '../editor-package/tables.mjs'
import { taggedProperties } from '../editor-package/properties.mjs'

const textures = new Set(['Texture2D'])

export function sourceNormalSettings(bytes) {
  try {
    const table = editorPackage(bytes)
    const texture = table?.topLevel(textures)
    if (!texture) return null
    const { properties } = taggedProperties(bytes, texture.start, texture.end, table.nameAt)
    const compression = properties.get('CompressionSettings')
    const srgb = properties.get('SRGB')
    const flip = properties.get('bFlipGreenChannel')
    if (compression?.type !== 'ByteProperty' || compression.inner !== 'TextureCompressionSettings' ||
        compression.size !== 8 || table.nameAt(compression.start) !== 'TC_Normalmap' ||
        srgb?.type !== 'BoolProperty' || srgb.size !== 0 || srgb.value !== 0 ||
        (flip && (flip.type !== 'BoolProperty' || flip.size !== 0 || ![0, 1].includes(flip.value)))) return null
    return { compression: 'TC_Normalmap', colorSpace: 'linear', flipGreenOnImport: flip?.value === 1 }
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}
