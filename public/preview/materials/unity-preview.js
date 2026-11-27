import * as THREE from 'three'
import { textureUrls } from './texture-references.js'
import { bindPackedChannels } from './packed-channels.js'

const slotForRole = {
  baseColor: 'map', normal: 'normalMap', emissive: 'emissiveMap',
  roughness: 'roughnessMap', metallic: 'metalnessMap', ambientOcclusion: 'aoMap',
}

function copyMaterial(source) {
  const material = new THREE.MeshStandardMaterial()
  THREE.Material.prototype.copy.call(material, source)
  for (const key of ['map', 'normalMap', 'emissiveMap', 'alphaMap', 'wireframe', 'flatShading', 'fog']) {
    if (key in source) material[key] = source[key]
  }
  material.color.copy(source.color)
  if (source.emissive) material.emissive.copy(source.emissive)
  if (source.normalScale) material.normalScale.copy(source.normalScale)
  return material
}

async function loadMap(binding, manager) {
  const { url, colorSpace, scale, offset } = binding
  const handler = manager.getHandler(url)
  let texture
  if (handler || typeof createImageBitmap === 'undefined') {
    texture = await (handler ?? new THREE.TextureLoader(manager)).loadAsync(url)
    texture.flipY = true
  } else {
    // Pixel data in RGB can be meaningful even when the packed A channel is zero.
    const loader = new THREE.ImageBitmapLoader(manager)
      .setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    texture = new THREE.Texture(await loader.loadAsync(url))
  }
  textureUrls.set(texture, url)
  texture.colorSpace = colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  if (scale) texture.repeat.fromArray(scale)
  if (offset) texture.offset.fromArray(offset)
  texture.needsUpdate = true
  return texture
}

export async function unityPreviewMaterial(source, plan, imagesByUrl, manager) {
  if (!source.isMeshPhongMaterial && !source.isMeshLambertMaterial) return null
  const material = copyMaterial(source)
  const { surface, maps } = plan
  const pending = new Map()
  const loaded = Object.create(null)
  const replacedTextures = new Set()
  function setMap(slot, texture) {
    if (material[slot] && material[slot] !== texture) replacedTextures.add(material[slot])
    material[slot] = texture
  }

  material.color.fromArray(surface.color)
  material.metalness = surface.metalness
  material.roughness = surface.roughness
  material.aoMapIntensity = surface.aoStrength
  material.emissive.fromArray(surface.emissive)
  material.alphaTest = surface.cutoff
  material.opacity = surface.opacity
  material.transparent = false
  material.depthWrite = true
  setMap('alphaMap', null)
  await Promise.all(Object.entries(slotForRole).map(async ([role, slot]) => {
    const binding = maps[role]
    if (!binding || !imagesByUrl.has(binding.url)) return
    const key = JSON.stringify([binding.url, binding.colorSpace, binding.scale, binding.offset])
    if (!pending.has(key)) pending.set(key, loadMap(binding, manager).catch(() => null))
    const texture = await pending.get(key)
    if (!texture) return
    loaded[role] = binding
    setMap(slot, texture)
  }))
  if (loaded.baseColor) material.vertexColors = false
  if (loaded.metallic) material.metalness = 1
  if (loaded.roughness) material.roughness = 1
  if (loaded.normal) material.normalScale.set(surface.normalScale, loaded.normal.flipGreen ? -surface.normalScale : surface.normalScale)
  bindPackedChannels(material, loaded)
  return { material, replacedTextures }
}
