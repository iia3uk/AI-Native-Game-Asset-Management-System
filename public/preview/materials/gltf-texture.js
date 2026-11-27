import * as THREE from 'three'
import { hasTextureImage } from './texture-image.js'
import { textureUrls } from './texture-references.js'
import { preferColoredImage } from './textures.js'

export async function applyGltfTexture(model, binding, files, manager) {
  const materials = new Set()
  model.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry.hasAttribute('uv')) return
    for (const material of [mesh.material].flat()) {
      if (material && 'map' in material && !hasTextureImage(material.map)) materials.add(material)
    }
  })
  if (!materials.size) return
  const images = files.filter(file => file.kind === 'image' && file.preview)
  const source = images.find(file => file.url === binding.url)
  const preferred = binding.palette ? source : preferColoredImage(source, images)
  const url = preferred?.url ?? binding.url
  const texture = await (manager.getHandler(url) ?? new THREE.TextureLoader(manager)).loadAsync(url).catch(() => null)
  if (!texture) return
  textureUrls.set(texture, url)
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  if (binding.palette) {
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
  }
  texture.needsUpdate = true
  for (const material of materials) {
    material.map = texture
    material.color?.setHex(0xffffff)
    if (binding.palette && 'metalness' in material) material.metalness = 0
    material.needsUpdate = true
  }
}
