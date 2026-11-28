import { editorPackage } from '../editor-package/tables.mjs'
import { taggedProperties } from '../editor-package/properties.mjs'

const textures = new Set(['Texture2D'])

function bool(field, fallback) {
  if (!field) return fallback
  return field.type === 'BoolProperty' && field.size === 0 && [0, 1].includes(field.value) ? !!field.value : null
}

export function sourceTextureSettings(bytes) {
  try {
    const table = editorPackage(bytes)
    const texture = table?.topLevel(textures)
    if (!texture) return null
    const { properties } = taggedProperties(bytes, texture.start, texture.end, table.nameAt)
    const compression = properties.get('CompressionSettings')
    if (compression && (compression.type !== 'ByteProperty' || compression.inner !== 'TextureCompressionSettings' ||
        compression.size !== 8)) return null
    const srgb = bool(properties.get('SRGB'), true)
    const flipGreenOnImport = bool(properties.get('bFlipGreenChannel'), false)
    const discardAlpha = bool(properties.get('CompressionNoAlpha'), false)
    const legacyGamma = bool(properties.get('bUseLegacyGamma'), false)
    if ([srgb, flipGreenOnImport, discardAlpha, legacyGamma].includes(null)) return null
    const repeat = ['AddressX', 'AddressY'].every(key => {
      const field = properties.get(key)
      return !field || (field.type === 'ByteProperty' && field.inner === 'TextureAddress' && field.size === 8 &&
        table.nameAt(field.start) === 'TA_Wrap')
    })
    return { compression: compression ? table.nameAt(compression.start) : 'TC_Default',
      srgb, flipGreenOnImport, discardAlpha, legacyGamma, repeat }
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

export function sourceNormalSettings(settings) {
  return settings?.compression === 'TC_Normalmap' && !settings.srgb ? {
    compression: settings.compression, colorSpace: 'linear', flipGreenOnImport: settings.flipGreenOnImport,
  } : null
}
