import { readPngRgb } from '../../../files/png-rgb.mjs'
import { comparableSampling, bundleImage } from './bundle-image.mjs'
import { bundleTarget } from './bundle-material.mjs'
import { metalRoughness, occlusionRed, tangentNormal, withoutAlpha } from './standard-pixels.mjs'
import { smoothnessFromAlbedo, standardSlotActive, unit } from './standard-slots.mjs'

const linearColor = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
const decodedAlpha = new Set(['rgba32', 'dxt5', 'bc7'])
const decodedGreen = new Set(['rgba32', 'dxt1', 'dxt5', 'bc5', 'bc7'])
const packedNormal = new Set(['dxt5', 'bc5'])
const supportedSlots = new Set(['_MainTex', '_MetallicGlossMap', '_BumpMap', '_EmissionMap', '_OcclusionMap'])
const unsupportedKeywords = new Set(['_PARALLAXMAP', '_DETAIL_MULX2', '_DETAIL_MUL', '_DETAIL_ADD', '_DETAIL_LERP',
  '_SPECULARHIGHLIGHTS_OFF', '_GLOSSYREFLECTIONS_OFF'])
const transformName = 'KHR_texture_transform'
const strengthName = 'KHR_materials_emissive_strength'

export async function standardPreview(source, primitive, { output, objects, images, extensions, signal }) {
  const material = source.material
  const active = new Set(material.keywords)
  const slots = new Map(material.textures.map(slot => [slot.property, slot]))
  const issues = new Set()
  const channels = []
  const uv = primitive.attributes?.TEXCOORD_0 !== undefined
  const transform = material.mainTransform ?? slots.get('_MainTex')
  const smoothAlbedo = active.has(smoothnessFromAlbedo)
  const color = (material.color ?? [1, 1, 1, 1]).map(unit)
  const pbr = { baseColorFactor: color.map((value, channel) => channel < 3 ? linearColor(value) : value),
    metallicFactor: unit(material.numbers._Metallic ?? 0), roughnessFactor: 1 - unit(material.numbers._Glossiness ?? .5) }
  const preview = { name: source.name, pbrMetallicRoughness: pbr }
  const cutout = material.numbers._Mode === 1
  if (cutout) Object.assign(preview, { alphaMode: 'MASK', alphaCutoff: unit(material.numbers._Cutoff ?? .5) })
  if (active.has('_ALPHABLEND_ON') || active.has('_ALPHAPREMULTIPLY_ON')) issues.add('unsupported-alpha')
  if (material.numbers._SmoothnessTextureChannel === 1 && !smoothAlbedo) issues.add('inactive-smoothness-source')
  if (!material.keywords && [...slots.keys()].some(property => !['_MainTex', '_OcclusionMap'].includes(property))) {
    issues.add('material-keywords')
  }
  if (material.textures.some(slot => !supportedSlots.has(slot.property) && standardSlotActive(slot.property, active)) ||
      [...active].some(keyword => unsupportedKeywords.has(keyword))) issues.add('unsupported-material-feature')

  const base = await load('_MainTex', 'srgb', null, smoothAlbedo)
  if (base) {
    const strip = cutout && smoothAlbedo
    const key = strip ? 'opaque:' + base.texture.id : base.texture.id
    pbr.baseColorTexture = add(key, strip ? () => withoutAlpha(base.image, signal) : base.bytes, base.texture, 'baseColor')
    if (!pbr.baseColorTexture) delete pbr.baseColorTexture
  }
  const metal = active.has('_METALLICGLOSSMAP') && await load('_MetallicGlossMap', 'linear', null, true, true)
  const smooth = smoothAlbedo ? base : metal
  const hasAlpha = smooth && decodedAlpha.has(smooth.texture.textureEncoding)
  if (smooth && !hasAlpha) issues.add('smoothness-source-unsupported')
  const packable = !metal || !hasAlpha || comparableSampling(metal.texture, smooth.texture)
  if (!packable) issues.add('smoothness-sampling-mismatch')
  const smoothMap = hasAlpha && packable ? smooth : null
  const scale = unit(material.numbers._GlossMapScale ?? 1)
  if (smoothAlbedo && !base && !slots.has('_MainTex')) pbr.roughnessFactor = 1 - scale
  if (metal || smoothMap) {
    const key = ['metal-rough', metal?.texture.id, smoothMap?.texture.id, scale].join(':')
    const bytes = () => metalRoughness(metal?.image, smoothMap?.image, scale, signal)
    const info = add(key, bytes, (metal || smoothMap).texture, 'metallicRoughness')
    if (info) {
      pbr.metallicRoughnessTexture = info
      if (metal) pbr.metallicFactor = 1
      if (smoothMap) pbr.roughnessFactor = 1
    }
  }

  const occlusion = await load('_OcclusionMap', 'linear', decodedGreen, true)
  if (occlusion) {
    const texture = occlusion.texture
    const info = add('occlusion:' + texture.id, () => occlusionRed(occlusion.image, signal), texture, 'occlusion')
    if (info) preview.occlusionTexture = { ...info, strength: unit(material.numbers._OcclusionStrength ?? 1) }
  }

  if (active.has('_NORMALMAP')) {
    if (primitive.attributes?.TANGENT === undefined || primitive.attributes?.NORMAL === undefined) issues.add('normal-tangent-missing')
    else {
      const normal = await load('_BumpMap', 'linear', packedNormal, true, true)
      if (normal) {
        const scale = material.numbers._BumpScale ?? 1
        const texture = normal.texture
        const info = add('normal:' + texture.id + ':' + scale, () => tangentNormal(normal.image, scale, signal), texture, 'normal')
        if (info) preview.normalTexture = info
      }
    }
  }

  if (active.has('_EMISSION')) {
    const color = (material.emissionColor ?? [0, 0, 0]).slice(0, 3).map(value => Math.max(0, value))
    const strength = Math.max(1, ...color)
    if (strength > 1) {
      extensions.add(strengthName)
      preview.extensions = { [strengthName]: { emissiveStrength: strength } }
    }
    preview.emissiveFactor = color.map(value => value / strength)
    const emission = await load('_EmissionMap', 'srgb')
    if (emission) {
      const info = add(emission.texture.id, emission.bytes, emission.texture, 'emissive')
      if (info) preview.emissiveTexture = info
    }
  }
  return { preview, issues, channels }

  async function load(property, colorSpace, formats, pixels, required = false) {
    const slot = slots.get(property)
    if (!slot) {
      if (required) issues.add('texture-reference-missing')
      return null
    }
    if (!uv) {
      issues.add('mesh-uv-missing')
      return null
    }
    const texture = bundleTarget(objects, source.member, slot.texture, 28)
    if (!texture) {
      issues.add('texture-reference-missing')
      return null
    }
    if (texture.textureColorSpace !== colorSpace || formats && !formats.has(texture.textureEncoding)) {
      issues.add('texture-format-unsupported')
      return null
    }
    const bytes = await bundleImage(output, texture, signal)
    const image = pixels && bytes ? readPngRgb(bytes, signal) : null
    if (!bytes || (pixels && (image?.width !== texture.width || image?.height !== texture.height || image?.channels !== 4))) {
      issues.add('texture-image-unavailable')
      return null
    }
    return { texture, bytes, image }
  }

  function add(key, bytes, texture, channel) {
    const name = key === texture.id ? texture.name : texture.name + ' ' + channel
    const index = images.add(key, texture, name, bytes, issues)
    if (index === undefined) return undefined
    channels.push(channel)
    const info = { index }
    if (transform) {
      const [sx, sy] = transform.scale
      const [ox, oy] = transform.offset
      if (sx !== 1 || sy !== 1 || ox !== 0 || oy !== 0) {
        info.extensions = { [transformName]: { scale: [sx, sy], offset: [ox, 1 - sy - oy] } }
        extensions.add(transformName)
      }
    }
    return info
  }
}
