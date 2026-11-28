import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { readPngPixels } from '../../../files/png-rgb.mjs'
import { encodePngScanlines } from '../../../files/png.mjs'

const byteLimit = 64 * 1024 ** 2
const maskCompression = new Set(['TC_Default', 'TC_Masks', 'TC_Grayscale'])
const colorSamplers = new Set(['SAMPLERTYPE_Color', 'SAMPLERTYPE_Grayscale'])
const srgbToLinear = Uint8Array.from({ length: 256 }, (_, byte) => {
  const v = byte / 255
  return Math.round(255 * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
})

function sourcePng(asset) {
  return asset?.exports.find(item => item.path && item.format === 'png' && item.role === 'texture' &&
    item.method === 'unreal-editor-source-media' && item.sampling?.repeat && item.size <= byteLimit)
}

async function verifiedPixels(store, artifact, signal) {
  const changed = () => new Error('Staged Unreal texture changed during opacity conversion')
  const file = await fileInfo(store.root, artifact.path)
  if (!file || file.info.size !== artifact.size) throw changed()
  const { prefix, hash } = await readVerifiedFile(store.root, file, { capture: artifact.size, changed, signal })
  if (hash !== artifact.sha256) throw changed()
  return readPngPixels(prefix, signal)
}

function combine(mask, color, alpha, srgb, signal) {
  const { width, height, channels, rowBytes, rows } = mask
  const stride = width * 4 + 1
  const output = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    signal?.throwIfAborted()
    let source = y * rowBytes + 1
    let rgb = color ? y * color.rowBytes + 1 : 0
    let destination = y * stride + 1
    for (let x = 0; x < width; x++) {
      const value = rows[source]
      if (!alpha && channels >= 3 && (value !== rows[source + 1] || value !== rows[source + 2])) return null
      if (color && color.channels >= 3) color.rows.copy(output, destination, rgb, rgb + 3)
      else output.fill(color ? color.rows[rgb] : 255, destination, destination + 3)
      output[destination + 3] = alpha ? rows[source + channels - 1] : srgb ? srgbToLinear[value] : value
      source += channels
      rgb += color?.channels ?? 0
      destination += 4
    }
  }
  return encodePngScanlines(width, height, output, { alpha: true })
}

export async function publishSourceOpacity(surface, { store, resolve, workspace, cache, version, signal, summary }) {
  if (surface?.blend !== 'BLEND_Masked' || surface.cutoff === null || surface.doubleSided === null || !surface.mask) return null
  const texture = resolve(surface.mask.path)
  const original = sourcePng(texture)
  const alpha = surface.mask.channel === 'alpha'
  if (!original || !maskCompression.has(original.sampling.compression) || (alpha ? original.sampling.discardAlpha :
    original.sampling.legacyGamma || original.sampling.srgb !== colorSamplers.has(surface.mask.sampleType))) return null
  const colorAsset = surface.color && resolve(surface.color.path)
  const candidate = sourcePng(colorAsset)
  const color = candidate?.sampling.srgb && !candidate.sampling.flipGreenOnImport &&
    !candidate.sampling.legacyGamma && candidate.sampling.compression === 'TC_Default' ? candidate : null
  const key = [texture.id, surface.mask.channel, color && colorAsset.id].filter(Boolean).join('-')
  if (!cache.has(key)) cache.set(key, await prepare())
  const output = cache.get(key)
  return output && { ...output, mode: 'MASK', cutoff: surface.cutoff, doubleSided: surface.doubleSided,
    definedIn: surface.definedIn, channel: surface.mask.channel, textureId: texture.id, sourcePath: surface.mask.path,
    sourceImage: original.path, texCoord: 0,
    ...(output.colorImage && { colorTextureId: colorAsset.id, colorSourcePath: surface.color.path }) }

  async function prepare() {
    const mask = await verifiedPixels(store, original, signal)
    if (!mask || (alpha && ![2, 4].includes(mask.channels))) return null
    if (alpha && color?.path === original.path && mask.channels === 4) {
      return { path: original.path, colorImage: color.path }
    }
    const pixels = color && (color.path === original.path ? mask : await verifiedPixels(store, color, signal))
    const matching = pixels?.width === mask.width && pixels.height === mask.height ? pixels : null
    const png = combine(mask, matching, alpha, original.sampling.srgb, signal)
    if (!png || await store.preflight(png.length)) return null
    const name = 'opacity-' + surface.mask.channel + '-' + (color ? colorAsset.id : 'neutral') + '.png'
    const temporary = join(workspace, texture.id + '-' + name)
    await writeFile(temporary, png, { flag: 'wx', signal })
    const artifact = await store.save('Textures/' + texture.id + '/' + name, { path: temporary, info: { size: png.length } }, {
      status: 'converted', format: 'png', role: 'preview-texture', method: 'unreal-opacity-mask', converterVersion: version,
      from: original.path, ...(matching && { colorFrom: color.path }), width: mask.width, height: mask.height,
    })
    texture.exports.push(artifact)
    if (!artifact.path) return null
    summary.opacityDerivatives++
    return { path: artifact.path, ...(matching && { colorImage: color.path }) }
  }
}
