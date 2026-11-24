import * as THREE from 'three'

const hasMap = material => {
  const image = material.map?.image
  return image?.width > 1 || image?.height > 1
}

function usedSlots(mesh, materials) {
  if (!Array.isArray(mesh.material)) return [0]
  return [...new Set(mesh.geometry.groups.filter(group => group.count >= 3).map(group => group.materialIndex))]
    .filter(index => materials[index]?.visible)
}

function lodGroup(mesh) {
  const pattern = /^(.*?)[ _-]lod[ _-]?(\d+)(?:[ _-]material[ _-]?\d+)?$/i
  const parent = mesh.parent
  const owner = parent && pattern.test(parent.name) ? parent : mesh
  const match = owner.name.match(pattern)
  if (match) return { group: `${owner.parent?.id ?? 0}:${match[1].toLowerCase()}`, level: Number(match[2]) }
}

function unlitMaterial(source) {
  const material = new THREE.MeshBasicMaterial({
    name: source.name, color: source.color ?? 0xffffff, map: source.map ?? null,
    alphaMap: source.alphaMap ?? null, alphaTest: source.alphaTest, opacity: source.opacity,
    transparent: source.transparent, side: source.side, vertexColors: source.vertexColors,
    depthWrite: source.depthWrite, depthTest: source.depthTest, blending: source.blending,
    premultipliedAlpha: source.premultipliedAlpha, wireframe: source.wireframe ?? false,
    toneMapped: false,
  })
  return material
}

export class PreviewParts {
  constructor(model) {
    this.meshes = []
    this.choices = []
    this.unlit = new Map()
    this.hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false })
    this.selection = null
    const closestLods = new Map()
    model.traverseVisible(mesh => {
      if (!mesh.isMesh || !mesh.geometry.getAttribute('position')?.count || !mesh.material) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const slots = usedSlots(mesh, materials)
      if (!slots.length || !materials.some(material => material.visible)) return
      const lod = lodGroup(mesh)
      if (lod) closestLods.set(lod.group, Math.min(lod.level, closestLods.get(lod.group) ?? Infinity))
      const part = { mesh, original: mesh.material, materials, slots, mask: mesh.layers.mask, lod }
      this.meshes.push(part)
      const name = mesh.name || mesh.geometry.name || `Объект ${this.meshes.length}`
      this.choices.push({ part, name })
      if (slots.length > 1) {
        for (const slot of slots) {
          const label = materials[slot].name || `Материал ${slot + 1}`
          this.choices.push({ part, slot, name: `${name} / ${label}` })
        }
      }
    })
    for (const part of this.meshes) part.defaultVisible = !part.lod || part.lod.level === closestLods.get(part.lod.group)
  }

  apply(unlit) {
    for (const part of this.meshes) {
      const { mesh, original, materials, mask } = part
      const selected = this.selection?.part === part
      mesh.layers.mask = (this.selection ? selected : part.defaultVisible) ? mask : 0
      if (!mesh.layers.mask) continue
      const slot = selected ? this.selection.slot : undefined
      if (!unlit && slot === undefined) {
        mesh.material = original
        continue
      }
      const mapped = materials.map((source, index) => {
        if (!source.visible || (slot !== undefined && index !== slot)) return this.hiddenMaterial
        if (!unlit) return source
        if (!this.unlit.has(source)) this.unlit.set(source, unlitMaterial(source))
        const material = this.unlit.get(source)
        if (material.map !== (source.map ?? null)) {
          material.map = source.map ?? null
          material.needsUpdate = true
        }
        if (source.color) material.color.copy(source.color)
        if (material.vertexColors !== source.vertexColors) {
          material.vertexColors = source.vertexColors
          material.needsUpdate = true
        }
        material.wireframe = source.wireframe ?? false
        return material
      })
      mesh.material = Array.isArray(original) ? mapped : mapped[0]
    }
  }

  select(index, unlit) {
    this.selection = this.choices[index] ?? null
    this.apply(unlit)
    return this.selection ? this.selectionBounds() : null
  }

  selectionBounds() {
    const { part: { mesh }, slot } = this.selection
    const geometry = mesh.geometry
    mesh.updateWorldMatrix(true, false)
    if (slot === undefined || mesh.isInstancedMesh) {
      const source = mesh.boundingBox === undefined ? geometry : mesh
      if (!source.boundingBox || mesh.isSkinnedMesh) source.computeBoundingBox()
      return source.boundingBox.clone().applyMatrix4(mesh.matrixWorld)
    }
    const box = new THREE.Box3()
    const point = new THREE.Vector3()
    const limit = geometry.index?.count ?? geometry.attributes.position.count
    for (const group of geometry.groups.filter(group => group.materialIndex === slot)) {
      for (let index = group.start; index < Math.min(limit, group.start + group.count); index++) {
        mesh.getVertexPosition(geometry.index?.getX(index) ?? index, point).applyMatrix4(mesh.matrixWorld)
        box.expandByPoint(point)
      }
    }
    return box
  }

  colorSummary() {
    const { part: selected, slot } = this.selection ?? {}
    const counts = { maps: 0, vertices: 0, flat: 0 }
    const seen = new Map()
    for (const { mesh, materials, slots } of selected ? [selected] : this.meshes.filter(part => part.defaultVisible)) {
      for (const index of slot === undefined ? slots : [slot]) {
        const material = materials[index]
        const type = hasMap(material) ? 'maps' : material.vertexColors && mesh.geometry.hasAttribute('color') ? 'vertices' : 'flat'
        if (!seen.has(material)) seen.set(material, new Set())
        const types = seen.get(material)
        if (!types.has(type)) counts[type]++
        types.add(type)
      }
    }
    return counts
  }

  dispose() {
    for (const { mesh, original, mask } of this.meshes) {
      mesh.material = original
      mesh.layers.mask = mask
    }
    for (const material of this.unlit.values()) material.dispose()
    this.hiddenMaterial.dispose()
  }
}
