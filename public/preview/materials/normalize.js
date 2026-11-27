import * as THREE from 'three'
import { hasTextureImage } from './texture-image.js'
import { fbxTextureRequests, missingColorMaps, textureUrl } from './texture-references.js'

const fallbackMaterial = () => new THREE.MeshStandardMaterial({ color: 0xc3cfb0, roughness: .78 })

export function normalizeFbx(model) {
  const materials = new Set()
  model.traverse(mesh => {
    if (!mesh.isMesh) return
    const position = mesh.geometry.getAttribute('position')
    if (!position?.count) return
    if (!mesh.geometry.hasAttribute('normal')) mesh.geometry.computeVertexNormals()
    if (Array.isArray(mesh.material) && !mesh.geometry.groups.length) {
      // An FBX can list several materials without assigning any polygon groups.
      const index = mesh.material.findIndex(Boolean)
      if (index < 0) mesh.material = fallbackMaterial()
      else mesh.geometry.addGroup(0, mesh.geometry.index?.count ?? position.count, index)
    }
    for (const material of [mesh.material].flat()) if (material) materials.add(material)
  })
  const replaced = model.userData.replacedTextures ??= new Set()
  for (const material of materials) {
    const { map, alphaMap } = material
    if (alphaMap && map && (alphaMap === map || (textureUrl(map) && textureUrl(map) === textureUrl(alphaMap)))) {
      // FBX may connect the same RGBA image to diffuse and transparency.
      // Three already reads its alpha from map. alphaMap would multiply by green.
      replaced.add(alphaMap)
      material.alphaMap = null
    }
    for (const [key, texture] of Object.entries(material)) {
      if (!texture?.isTexture || hasTextureImage(texture)) continue
      if (key === 'map' && fbxTextureRequests.has(texture)) missingColorMaps.set(material, fbxTextureRequests.get(texture))
      replaced.add(texture)
      material[key] = null
    }
    material.needsUpdate = true
  }
}

export function normalizeFbxVertexColors(model) {
  model.traverse(mesh => {
    if (!mesh.isMesh) return
    const materials = [mesh.material].flat().filter(material => material?.vertexColors)
    if (!materials.length) return
    const { geometry } = mesh
    const color = geometry.getAttribute('color')
    if (!color?.count) {
      // FBX materials can be shared by meshes with and without a vertex color layer.
      const count = geometry.getAttribute('position')?.count ?? 0
      if (count) geometry.setAttribute('color', new THREE.Uint8BufferAttribute(new Uint8Array(count * 3).fill(255), 3, true))
      return
    }
    if (!materials.some(material => hasTextureImage(material.map))) return
    for (let index = 0; index < color.count; index++) {
      if (color.getX(index) !== 0 || color.getY(index) !== 0 || color.getZ(index) !== 0) return
    }
    // Use a neutral multiplier for an unused black mask, preserving any vertex alpha.
    for (let index = 0; index < color.count; index++) color.setXYZ(index, 1, 1, 1)
    color.needsUpdate = true
  })
}

export function normalizePreviewMaterials(model, file) {
  if (!file.previewAlbedo && !file.previewVertexMask && !file.previewAlphaCutout) return
  const materials = new Set()
  model.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry.hasAttribute('uv')) return
    for (const material of [mesh.material].flat()) if (material) materials.add(material)
  })
  for (const material of materials) {
    if (!hasTextureImage(material.map)) continue
    if (file.previewAlbedo) material.color?.setHex(0xffffff)
    if (file.previewVertexMask) material.vertexColors = false
    if (file.previewAlphaCutout) {
      material.alphaTest = .5
      material.side = THREE.DoubleSide
    }
    material.needsUpdate = true
  }
}
