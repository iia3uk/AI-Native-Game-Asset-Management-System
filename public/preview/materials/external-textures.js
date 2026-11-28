import * as THREE from 'three'
import { convertedImages } from '../loaders/image-preview.js'
import { closest } from '../resource-proximity.js'
import { findColorTexture, materialStem } from './color-selection.js'
import { hasTextureImage } from './texture-image.js'
import { missingColorMaps, textureUrl, textureUrls } from './texture-references.js'
import { unityPreviewMaterial } from './unity-preview.js'
import { colorSuffix, companionTexture, copyTextureMapping, idSuffix, isSingleChannelSignal, opacitySuffix, resemblesVertexMask, textureName } from './textures.js'

export async function applyExternalTextures(model, file, files, unityMaterials, manager) {
  const bindings = file.materialTextures ?? {}
  const images = files.filter(item => item.kind === 'image' && (item.preview || convertedImages.has(item.ext)) &&
    !item.path.includes('/.unity-previews/'))
  const meshes = []
  const materialMeshes = new Map()
  const replacedTextures = new Set()
  const variantGroups = []
  const upgradedMaterials = new Map()
  model.traverseVisible(mesh => {
    if (!mesh.isMesh || !mesh.geometry.hasAttribute('uv') || !mesh.geometry.attributes.position?.count) return
    meshes.push(mesh)
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material || !('map' in material)) continue
      if (!materialMeshes.has(material)) materialMeshes.set(material, new Set())
      materialMeshes.get(material).add(mesh)
    }
  })
  const prefab = file.prefabTextures
  const prefabMeshes = prefab?.mesh ? meshes.filter(mesh => mesh.name === prefab.mesh) : meshes
  const prefabTextures = new Map()
  if (prefab && prefabMeshes.length === 1) {
    const [mesh] = prefabMeshes
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (materials.length === prefab.slots.length) {
      materials.forEach((material, index) => {
        if (prefab.slots[index] && materialMeshes.get(material)?.size === 1) prefabTextures.set(material, prefab.slots[index])
      })
    }
  }
  const loadTexture = async url => {
    const texture = await (manager.getHandler(url) ?? new THREE.TextureLoader(manager)).loadAsync(url)
    textureUrls.set(texture, url)
    return texture
  }
  const imagesByUrl = new Map(images.map(image => [image.url, image]))
  const imageForUrl = url => url && imagesByUrl.get(new URL(url, location.origin).pathname)
  const isVertexMask = (material, uses, url, variants = []) => {
    if (file.ext !== 'fbx' || !material.vertexColors || !url) return false
    const color = imageForUrl(url)
    if (!color) return false
    const layers = [...uses].map(mesh => mesh.geometry.getAttribute('color')).filter(Boolean)
    if (!layers.length) return false
    if (companionTexture(color, images, idSuffix) && companionTexture(color, images, opacitySuffix)) {
      return layers.every(resemblesVertexMask)
    }
    const shared = { sharedVariant: true }
    return variants.length > 1 && variants.includes(color) &&
      companionTexture(color, images, /[_ -]+(?:n|nrm|normal)$/i, shared) &&
      companionTexture(color, images, /[_ -]+(?:r|roughness)$/i, shared) &&
      layers.every(isSingleChannelSignal)
  }
  await Promise.all([...materialMeshes.keys()].map(async material => {
    const key = material.name.trim().normalize('NFC').toLowerCase()
    const explicit = Object.hasOwn(bindings, key) ? bindings[key] : null
    const uses = materialMeshes.get(material)
    const prefabBinding = prefabTextures.get(material)
    const provenBinding = explicit?.remap ? explicit : prefabBinding
    if (provenBinding?.pbr && file.ext === 'fbx' && (!file.previewFormat || file.previewFormat === 'fbx')) {
      const upgraded = await unityPreviewMaterial(material, provenBinding.pbr, imagesByUrl, manager)
      if (upgraded) {
        upgradedMaterials.set(material, upgraded.material)
        for (const texture of upgraded.replacedTextures) replacedTextures.add(texture)
        return
      }
    }
    const [owner] = uses
    const meshNames = !Array.isArray(owner.material) ? new Set([...uses].map(mesh => mesh.name)) : new Set()
    const meshName = meshNames.size && new Set([...meshNames].map(materialStem)).size === 1 ? owner.name : ''
    const single = materialMeshes.size === 1 && file.url.startsWith('/local-files/')
    const findByName = () => findColorTexture(key, file, images) ??
      (meshName ? findColorTexture(meshName, file, images) : undefined) ??
      (single ? findColorTexture(file.name.slice(0, -(file.ext.length + 1)), file, images) : undefined)
    if (hasTextureImage(material.map) && !explicit?.remap) {
      const url = textureUrl(material.map)
      const variants = (file.previewAlbedo || (file.ext === 'fbx' && material.vertexColors)) && findByName()?.variants
      if (isVertexMask(material, uses, url, variants || [])) {
        material.vertexColors = false
        material.needsUpdate = true
      }
      if (!variants || variants.length < 2) return
      const authored = variants.indexOf(imageForUrl(url))
      if (authored < 0 && !file.previewAlbedo) return
      const saved = file.previewTextureNames ?? []
      const matches = variants.filter(item => saved.includes(item.name.toLowerCase()))
      const resolved = authored >= 0 ? authored : matches.length === 1 ? variants.indexOf(matches[0]) : -1
      const files = resolved >= 0 ? variants : [{ name: 'Исходная (FBX)' }, ...variants]
      const index = Math.max(0, resolved)
      const original = material.map
      replacedTextures.add(original)
      variantGroups.push({ material, files, index, loadTexture, original, originalIndex: index })
      return
    }
    const getNamed = name => Object.hasOwn(unityMaterials, name) ? unityMaterials[name] : []
    const named = closest(getNamed(key), file) ?? (key.startsWith('mi_') ? closest(getNamed('m_' + key.slice(3)), file) : null)
    const unityBinding = explicit?.url || explicit?.variants?.length ? explicit : prefabBinding?.url ? prefabBinding : named
    const binding = unityBinding ?? findByName()
    if (!binding) return
    try {
      const missing = missingColorMaps.get(material)?.toLowerCase().replace(/\.[^.]+$/, '')
      const variants = binding.variants ?? []
      const preferred = variants.findIndex(image => textureName(image).replace(colorSuffix, '').toLowerCase() === missing)
      const defaultIndex = Math.max(0, preferred)
      const colorUrl = variants[defaultIndex]?.url ?? binding.url
      const texture = await loadTexture(colorUrl)
      texture.colorSpace = THREE.SRGBColorSpace
      if (file.previewFormat === 'glb' || ['glb', 'gltf', 'vrm'].includes(file.ext)) texture.flipY = false
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      if (binding.scale?.every(Number.isFinite)) texture.repeat.fromArray(binding.scale)
      if (binding.offset?.every(Number.isFinite)) texture.offset.fromArray(binding.offset)
      if (material.map) replacedTextures.add(material.map)
      material.map = texture
      material.color?.setHex(0xffffff)
      // Unity shaders can use vertex colors as masks. This fallback applies a flat color texture.
      if ((unityBinding && file.ext === 'fbx') || isVertexMask(material, uses, colorUrl, variants)) material.vertexColors = false
      if (binding.alphaUrl && !hasTextureImage(material.alphaMap)) {
        const alpha = await loadTexture(binding.alphaUrl).catch(() => null)
        if (alpha) {
          copyTextureMapping(alpha, texture)
          alpha.needsUpdate = true
          if (material.alphaMap) replacedTextures.add(material.alphaMap)
          material.alphaMap = alpha
        }
      }
      if (Number.isFinite(binding.alphaTest) && (!binding.alphaUrl || hasTextureImage(material.alphaMap))) {
        material.alphaTest = binding.alphaTest
        if (material.opacity === 1 && binding.alphaTest > 0) material.transparent = false
      }
      texture.needsUpdate = true
      material.needsUpdate = true
      if (variants.length > 1) variantGroups.push({ material, files: variants, loadTexture, index: defaultIndex })
    } catch { /* keep the original material when its external texture cannot be decoded */ }
  }))
  if (upgradedMaterials.size) {
    const replacement = material => upgradedMaterials.get(material) ?? material
    for (const mesh of meshes) {
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(replacement) : replacement(mesh.material)
    }
    model.userData.replacedMaterials = new Set(upgradedMaterials.keys())
  }
  for (const texture of replacedTextures) model.userData.replacedTextures.add(texture)
  return variantGroups
}
