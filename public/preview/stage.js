import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TGALoader } from 'three/addons/loaders/TGALoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { geometryBounds, PreviewParts } from './scene/parts.js'
import { disposeModel } from './scene/dispose.js'
import { animatedTranslationRoot } from './scene/animation-motion.js'
import { resolveResources } from './loaders/resources.js'
import { ViewerTiffLoader } from './loaders/fbx-images.js'
import { convertedImages } from './loaders/image-preview.js'
import { loadModel } from './loaders/model.js'
import { applyGltfTexture } from './materials/gltf-texture.js'
import { applyExternalTextures } from './materials/external-textures.js'
import { normalizeFbx, normalizeFbxVertexColors, normalizePreviewMaterials } from './materials/normalize.js'
import { textureUrl } from './materials/texture-references.js'
import { copyTextureMapping } from './materials/textures.js'

const frameDistance = (radius, fov, aspect) => {
  const halfVertical = THREE.MathUtils.degToRad(fov / 2)
  const halfAngle = Math.atan(Math.tan(halfVertical) * Math.min(1, aspect))
  return radius / Math.sin(halfAngle) * 1.22
}

export class ModelStage {
  constructor(element) {
    this.element = element
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.18
    this.renderer.domElement.tabIndex = 0
    this.renderer.domElement.setAttribute('aria-label', 'Интерактивная 3D-модель')
    element.append(this.renderer.domElement)
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(38, 1, .01, 1500)
    this.camera.position.set(3.1, 2.4, 3.65)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.autoRotateSpeed = 1.35
    this.ambient = new THREE.HemisphereLight(0xffffff, 0x8f8f8f)
    this.key = new THREE.DirectionalLight(0xffffff)
    this.key.position.set(4, 8, 5)
    this.rim = new THREE.DirectionalLight(0xffffff)
    this.rim.position.set(-4, 5, -2)
    this.scene.add(this.ambient, this.key, this.rim)
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.scene.environment = pmrem.fromScene(room, .04, .1, 100, { size: 128 }).texture
    room.dispose()
    pmrem.dispose()
    this.setLighting('studio')
    this.grid = new THREE.GridHelper(20, 30, 0x789273, 0x526c53)
    this.grid.material.transparent = true
    this.grid.material.opacity = .36
    this.scene.add(this.grid)
    this.request = 0
    this.inPlace = true
    this.motionOrigin = new THREE.Vector3()
    this.motionSample = new THREE.Vector3()
    this.frameTime = performance.now()
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(element)
    this.resize()
    this.renderer.setAnimationLoop(time => {
      const elapsed = Math.min(.1, Math.max(0, (time - this.frameTime) / 1000))
      this.frameTime = time
      if (!this.element.hidden) {
        this.updateAnimation(elapsed)
        this.controls.update(elapsed)
        this.renderer.render(this.scene, this.camera)
      }
    })
  }

  resize() {
    const width = this.element.clientWidth
    const height = this.element.clientHeight
    if (!width || !height) return
    const aspect = width / height
    if (this.bounds && aspect !== this.camera.aspect) {
      const radius = Math.max(this.bounds.getBoundingSphere(new THREE.Sphere()).radius, .002)
      const distance = frameDistance(radius, this.camera.fov, aspect)
      const previous = frameDistance(radius, this.camera.fov, this.camera.aspect)
      const target = this.controls.target
      this.camera.position.sub(target).multiplyScalar(distance / previous).add(target)
      this.updateFramingLimits(radius, distance)
    }
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
  }

  resetModel() {
    for (const [material, override] of this.colorOverrides ?? []) {
      override.texture?.dispose()
      material.map = override.originalMap
      material.color?.copy(override.originalColor)
      material.vertexColors = override.vertexColors
    }
    this.colorOverrides = new Map()
    this.manualMaterials = []
    this.manualTextureLoader = null
    this.parts?.dispose()
    this.parts = null
    this.sceneBounds = null
    if (this.skeleton) {
      this.scene.remove(this.skeleton)
      this.skeleton.dispose()
      this.skeleton = null
    }
    if (this.root) {
      this.scene.remove(this.root)
      this.mixer?.stopAllAction()
      if (this.model) this.mixer?.uncacheRoot(this.model)
      disposeModel(this.root)
    }
    this.root = this.model = this.mixer = this.active = this.bounds = null
    this.motionAnchor = this.animationOffset = null
    this.variantGroups = []
    this.variantLoad = null
    this.clips = []
    this.controls.autoRotate = false
  }

  clear() {
    this.request++
    this.resetModel()
  }

  async load(file, files, unityMaterials = {}) {
    this.resetModel()
    const request = ++this.request
    const resources = resolveResources(file, files)
    const { manager, settled, release } = resources
    let model
    let animations = []
    let variantGroups = []
    const type = file.previewFormat ?? (file.ext === 'vrm' ? 'glb' : file.ext)
    const local = file.url.startsWith('/local-files/')
    try {
      const loaded = await loadModel(type, file, { ...resources, renderer: this.renderer })
      model = loaded.model
      animations = loaded.animations
      if ((type === 'glb' || type === 'gltf') && file.previewTexture && request === this.request) {
        await applyGltfTexture(model, file.previewTexture, files, manager)
      }
      await settled()
      model.userData.replacedTextures = new Set()
      if (request === this.request) {
        if (type === 'fbx') normalizeFbx(model)
        if ((type === 'fbx' || type === 'glb' || type === 'gltf' || local) && (file.materialTextures || file.prefabTextures || files.some(item => item.kind === 'image'))) {
          variantGroups = await applyExternalTextures(model, file, files, unityMaterials, manager)
        }
        if (type === 'fbx') normalizeFbxVertexColors(model)
        normalizePreviewMaterials(model, file)
      }
    } catch (error) {
      if (model) disposeModel(model)
      throw error
    } finally {
      await release()
    }
    if (request !== this.request) {
      disposeModel(model)
      return null
    }
    model.updateMatrixWorld(true)
    const parts = new PreviewParts(model)
    const box = new THREE.Box3()
    let points = 0
    let lines = 0
    for (const { mesh, defaultVisible } of parts.meshes) {
      if (!defaultVisible || !this.camera.layers.test(mesh.layers)) continue
      const bounds = geometryBounds(mesh)
      if (bounds) box.union(bounds)
    }
    model.traverseVisible(object => {
      if ((!object.isPoints && !object.isLine) || !object.geometry.getAttribute('position')?.count ||
          ![object.material].flat().some(material => material?.visible) || !this.camera.layers.test(object.layers)) return
      const bounds = geometryBounds(object)
      if (!bounds) return
      box.union(bounds)
      if (object.isPoints) points += object.geometry.getAttribute('position').count
      if (object.isLine) lines++
    })
    const skeletonOnly = box.isEmpty()
    let boneCount = 0
    if (skeletonOnly) {
      const position = new THREE.Vector3()
      model.traverse(item => {
        if (!item.isBone) return
        item.getWorldPosition(position)
        if ([...position].every(Number.isFinite)) box.expandByPoint(position)
        boneCount++
      })
    }
    if (box.isEmpty()) {
      parts.dispose()
      disposeModel(model)
      return { empty: true, clips: animations, meshes: 0, triangles: 0 }
    }
    const center = box.getCenter(new THREE.Vector3())
    const container = new THREE.Group()
    container.position.set(-center.x, -box.min.y, -center.z)
    container.add(model)
    this.scene.add(container)
    container.updateMatrixWorld(true)
    if (skeletonOnly) {
      this.skeleton = new THREE.SkeletonHelper(model)
      this.scene.add(this.skeleton)
    }
    this.root = container
    this.model = model
    this.variantGroups = variantGroups
    const materials = new Set()
    model.traverse(mesh => {
      if (!mesh.isMesh || !mesh.geometry.hasAttribute('uv')) return
      for (const material of [mesh.material].flat()) {
        if (material && 'map' in material) materials.add(material)
      }
    })
    this.manualMaterials = [...materials]
    this.manualTextureLoader = file => {
      const loader = file.ext === 'tga' ? new TGALoader() : convertedImages.has(file.ext) ? new ViewerTiffLoader() : new THREE.TextureLoader()
      return loader.loadAsync(file.url)
    }
    this.manualFlipY = type !== 'gltf' && type !== 'glb'
    this.sceneBounds = this.bounds = box.clone().translate(container.position)
    this.parts = parts
    this.parts.apply(this.lighting === 'unlit')
    this.clips = animations ?? []
    this.mixer = this.clips.length ? new THREE.AnimationMixer(model) : null
    this.animationOffset = this.mixer ? container.position.clone() : null
    if (this.mixer) model.traverse(node => {
      // Skinned vertices can leave their rest bounds during a clip.
      if (node.isSkinnedMesh) node.frustumCulled = false
    })
    const size = this.bounds.getSize(new THREE.Vector3())
    this.grid.scale.setScalar(Math.max(.015, Math.max(size.x, size.y, size.z) / 3.5))
    this.grid.position.y = -Math.max(.0002, size.length() * .0002)
    this.fit()
    let meshes = 0
    let triangles = 0
    for (const { mesh, defaultVisible } of parts.meshes) {
      if (!defaultVisible) continue
      meshes++
      triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3
    }
    return { meshes, triangles: Math.round(triangles), points, lines, clips: this.clips, skeletonOnly, boneCount, empty: false,
      parts: this.parts.choices.map(item => item.name) }
  }

  setLighting(mode) {
    this.lighting = mode
    const bright = mode === 'bright'
    this.renderer.toneMappingExposure = bright ? 1.4 : 1.08
    this.scene.environmentIntensity = bright ? .9 : .62
    this.ambient.intensity = bright ? 2.85 : 1.6
    this.key.intensity = bright ? 3.0 : 2.15
    this.rim.intensity = 1.1
    this.parts?.apply(mode === 'unlit')
  }

  showPart(index) {
    this.variantLoad = null
    const box = this.parts?.select(index, this.lighting === 'unlit')
    this.bounds = box && !box.isEmpty() ? box : this.sceneBounds
    this.fit()
  }

  get variant() {
    const selected = this.parts?.selection
    const materials = selected && (selected.slot === undefined ? selected.part.materials : [selected.part.materials[selected.slot]])
    const groups = materials ? this.variantGroups.filter(group => materials.includes(group.material)) : this.variantGroups
    return groups.length === 1 && !this.colorOverrides.has(groups[0].material) ? groups[0] : null
  }

  manualTexture(index) {
    return this.colorOverrides.get(this.manualMaterials[index])?.fileId ?? ''
  }

  automaticTexture(index) {
    const material = this.manualMaterials[index]
    const override = this.colorOverrides.get(material)
    return textureUrl(override ? override.originalMap : material?.map)
  }

  async setManualTexture(index, file) {
    const material = this.manualMaterials[index]
    if (!material) return
    this.variantLoad = null
    const previous = this.colorOverrides.get(material)
    if (!file) {
      if (!previous) return
      previous.texture?.dispose()
      material.map = previous.originalMap
      if (previous.originalColor) material.color.copy(previous.originalColor)
      material.vertexColors = previous.vertexColors
      this.colorOverrides.delete(material)
    } else {
      const override = {
        originalMap: previous ? previous.originalMap : material.map,
        originalColor: previous ? previous.originalColor : material.color?.clone(),
        vertexColors: previous ? previous.vertexColors : material.vertexColors,
        texture: previous?.texture, fileId: previous?.fileId,
      }
      this.colorOverrides.set(material, override)
      const texture = await this.manualTextureLoader(file).catch(() => null)
      if (this.colorOverrides.get(material) !== override) { texture?.dispose(); return }
      if (!texture) {
        if (previous) this.colorOverrides.set(material, previous)
        else this.colorOverrides.delete(material)
        throw new Error('Текстура не открылась')
      }
      texture.colorSpace = THREE.SRGBColorSpace
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      copyTextureMapping(texture, override.originalMap, this.manualFlipY)
      texture.needsUpdate = true
      override.texture?.dispose()
      override.texture = material.map = texture
      override.fileId = file.selectionId ?? file.id
      material.color?.setHex(0xffffff)
      material.vertexColors = false
    }
    material.needsUpdate = true
    this.parts?.apply(this.lighting === 'unlit')
  }

  async setTextureVariant(index) {
    const variant = this.variant
    const file = variant?.files[index]
    if (!file) return
    const request = this.variantLoad = Symbol()
    if (index === variant.index) return
    const useOriginal = index === variant.originalIndex
    let texture
    try {
      texture = useOriginal ? variant.original : await variant.loadTexture(file.url)
    } catch (error) {
      if (request === this.variantLoad) throw error
      return
    }
    if (request !== this.variantLoad) {
      if (!useOriginal) texture.dispose()
      return
    }
    const { material } = variant
    const previous = material.map
    if (!useOriginal) {
      texture.colorSpace = THREE.SRGBColorSpace
      copyTextureMapping(texture, previous, this.manualFlipY)
      texture.needsUpdate = true
    }
    if (previous !== variant.original) previous.dispose()
    material.map = texture
    material.needsUpdate = true
    variant.index = index
    this.parts?.apply(this.lighting === 'unlit')
  }

  fit() {
    if (!this.bounds) return
    const sphere = this.bounds.getBoundingSphere(new THREE.Sphere())
    const radius = Math.max(sphere.radius, .002)
    const distance = frameDistance(radius, this.camera.fov, this.camera.aspect)
    this.camera.position.copy(sphere.center).addScaledVector(new THREE.Vector3(1.15, .68, 1.45).normalize(), distance)
    this.updateFramingLimits(radius, distance)
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(sphere.center)
    this.controls.update()
  }

  updateFramingLimits(radius, distance) {
    this.camera.near = Math.max(.00002, radius / 500)
    const maxDistance = Math.max(radius * 35, distance * 2)
    this.camera.far = Math.max(radius * 180, maxDistance + radius * 4)
    this.controls.minDistance = radius * .1
    this.controls.maxDistance = maxDistance
  }

  zoom(inward) {
    if (!this.bounds) return
    if (inward) this.controls.dollyIn(.8)
    else this.controls.dollyOut(.8)
  }

  wireframe(active) {
    for (const { materials } of this.parts?.meshes ?? []) {
      for (const material of materials) {
        if (material && 'wireframe' in material) material.wireframe = active
      }
    }
    this.parts?.apply(this.lighting === 'unlit')
  }

  play(index) {
    const clip = this.clips[index]
    if (!this.mixer || !clip) return false
    if (this.active?.getClip() === clip && this.active.paused) {
      this.active.paused = false
    } else {
      this.mixer.stopAllAction()
      this.root.position.copy(this.animationOffset)
      this.motionAnchor = animatedTranslationRoot(this.model, clip)
      this.motionAnchor?.getWorldPosition(this.motionOrigin)
      this.active = this.mixer.clipAction(clip)
      this.active.reset().play()
      this.updateAnimation(0)
    }
    return true
  }

  updateAnimation(elapsed) {
    this.mixer?.update(elapsed)
    if (!this.inPlace || !this.motionAnchor) return
    this.motionAnchor.getWorldPosition(this.motionSample)
    // Move only the preview container. The clip still controls height and rotation.
    this.root.position.x += this.motionOrigin.x - this.motionSample.x
    this.root.position.z += this.motionOrigin.z - this.motionSample.z
  }

  setInPlace(enabled) {
    this.inPlace = enabled
    if (enabled) this.updateAnimation(0)
    else if (this.animationOffset) this.root.position.copy(this.animationOffset)
  }

  pause() {
    if (this.active) this.active.paused = true
  }
}
