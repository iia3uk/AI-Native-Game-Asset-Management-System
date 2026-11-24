import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { TGALoader } from 'three/addons/loaders/TGALoader.js'
import { TIFFLoader } from 'three/addons/loaders/TIFFLoader.js'
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js'
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { geometryBounds, hasTextureImage, PreviewParts } from './parts.js'
import { colorSuffix, companionTexture, copyTextureMapping, idSuffix, isDataMap,
  opacitySuffix, preferColoredImage, resemblesVertexMask, textureName } from './textures.js'
import { animatedTranslationRoot } from './animation-motion.js'

const fallbackMaterial = () => new THREE.MeshStandardMaterial({ color: 0xc3cfb0, roughness: .78 })
const textureUrls = new WeakMap()
const textureUrl = texture => textureUrls.get(texture) ?? texture?.image?.src
const frameDistance = (radius, fov, aspect) => {
  const halfVertical = THREE.MathUtils.degToRad(fov / 2)
  const halfAngle = Math.atan(Math.tan(halfVertical) * Math.min(1, aspect))
  return radius / Math.sin(halfAngle) * 1.22
}

function withFbxWrapping(Loader) {
  return class extends Loader {
    load(url, ...callbacks) {
      const texture = super.load(url, ...callbacks)
      textureUrls.set(texture, this.manager.resolveURL((this.path ?? '') + url))
      return texture
    }

    _applyTexData(texture, data) {
      // FBXLoader sets the authored wrapping on the texture before its pixels arrive.
      super._applyTexData(texture, { ...data, wrapS: texture.wrapS, wrapT: texture.wrapT })
    }
  }
}

const FbxTgaLoader = withFbxWrapping(TGALoader)
class ViewerTiffLoader extends TIFFLoader {
  parse(buffer) {
    return { ...super.parse(buffer), generateMipmaps: true }
  }
}
const FbxTiffLoader = withFbxWrapping(ViewerTiffLoader)
export const convertedImages = new Set(['tga', 'tif', 'tiff'])

export async function decodedImageUrl(file) {
  const loader = file.ext === 'tga' ? new TGALoader() : new TIFFLoader()
  const texture = await loader.loadAsync(file.url)
  try {
    const { data, width, height } = texture.image
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0)
    const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!image) throw new Error('Не удалось подготовить изображение')
    return URL.createObjectURL(image)
  } finally {
    texture.dispose()
  }
}

function dispose(object) {
  const geometry = new Set()
  const materials = new Set()
  const textures = new Set()
  const skeletons = new Set()
  object.traverse(item => {
    for (const texture of item.userData.replacedTextures ?? []) textures.add(texture)
    if (item.geometry) geometry.add(item.geometry)
    if (item.skeleton) skeletons.add(item.skeleton)
    for (const material of Array.isArray(item.material) ? item.material : item.material ? [item.material] : []) {
      if (!material) continue
      materials.add(material)
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
    }
  })
  for (const item of [...geometry, ...materials, ...textures, ...skeletons]) item.dispose()
  if (typeof ImageBitmap !== 'undefined') {
    const bitmaps = new Set([...textures].map(texture => texture.image).filter(image => image instanceof ImageBitmap))
    for (const bitmap of bitmaps) bitmap.close()
  }
}

function resolveResources(file, files) {
  const manager = new THREE.LoadingManager()
  const objectUrls = new Set()
  let pending, finish
  manager.onStart = () => { pending ??= new Promise(resolve => { finish = resolve }) }
  manager.onLoad = () => { finish?.(); pending = finish = null }
  const tga = file.ext === 'fbx' ? new FbxTgaLoader(manager) : new TGALoader(manager)
  manager.addHandler(/\.tga(?:$|\?)/i, tga)
  const tiff = file.ext === 'fbx' ? new FbxTiffLoader(manager) : new ViewerTiffLoader(manager)
  manager.addHandler(/\.tiff?(?:$|\?)/i, tiff)
  const resources = new Map(files.map(item => [item.url, item]))
  const lowerUrls = new Map()
  const names = new Map()
  for (const item of files) {
    const key = item.url.toLowerCase()
    lowerUrls.set(key, lowerUrls.has(key) ? null : item)
    const name = item.name.toLowerCase()
    if (!names.has(name)) names.set(name, [])
    names.get(name).push(item)
  }
  const filePath = file.path.toLowerCase().split('/')
  const rank = candidate => {
    const path = candidate.path.toLowerCase().split('/')
    let score = 0
    while (score < filePath.length && filePath[score] === path[score]) score++
    return score
  }
  const findResource = (reference, base = location.origin) => {
    const input = reference.replaceAll('\\', '/')
    let url
    try { url = new URL(input, base) } catch { return undefined }
    if (url.origin === location.origin) {
      const exact = resources.get(url.pathname) ?? lowerUrls.get(url.pathname.toLowerCase())
      if (exact) return exact
    }
    const basename = input.split('/').at(-1)
    for (const key of [basename, url.pathname.split('/').at(-1)]) {
      let name = key ?? ''
      try { name = decodeURIComponent(key) } catch { /* filenames may contain a literal percent sign */ }
      const candidates = names.get(name.toLowerCase())
      if (candidates?.length) return file.url.startsWith('/local-files/') ? closest(candidates, file) :
        [...candidates].sort((a, b) => rank(b) - rank(a))[0]
    }
  }
  manager.setURLModifier(input => {
    if (input.startsWith('blob:')) objectUrls.add(input)
    if (input.startsWith('data:') || input.startsWith('blob:')) return input
    try {
      const url = new URL(input.replaceAll('\\', '/'), location.origin)
      if (url.origin === location.origin && (url.pathname === file.preview || url.pathname.startsWith('/vendor/three/'))) {
        return url.pathname + url.search
      }
      return findResource(input)?.url ?? '/missing-resource'
    } catch { return '/missing-resource' }
  })
  const release = async () => {
    await pending
    for (const url of objectUrls) URL.revokeObjectURL(url)
    objectUrls.clear()
  }
  return { manager, findResource, settled: () => pending, release }
}

function closest(candidates, source) {
  if (candidates.length < 2) return candidates[0]
  const root = source.url.startsWith('/local-files/') && source.url.split('/', 3)[2]
  if (root) {
    const ownFolder = candidates.filter(file => file.url?.startsWith('/local-files/' + root + '/'))
    if (ownFolder.length < 2) return ownFolder[0]
    candidates = ownFolder
  }
  const directory = file => file.path.toLowerCase().split('/').slice(0, -1)
  const parent = directory(source)
  const ranked = candidates.map(file => {
    const parts = directory(file)
    let shared = 0
    while (shared < parent.length && parts[shared] === parent[shared]) shared++
    return { file, shared, distance: parent.length + parts.length - 2 * shared }
  }).sort((a, b) => b.shared - a.shared || a.distance - b.distance)
  const [best, next] = ranked
  if (best.shared > next.shared || best.distance < next.distance) return best.file
}

function materialStem(name = '') {
  return name.toLowerCase().replace(/\.(?:fbx|obj|blend|gltf|glb)$/, '')
    .replace(/[ _.-]+lod[ _.-]?\d+(?:[ _.-]+material[ _.-]?\d+)?$/, '')
    .replace(/^(?:mi|m|t|sm|sk)[_ -]+/, '').replace(/[^a-z\d]/g, '')
}

function findColorTexture(key, file, images) {
  const stem = materialStem(key)
  if (!stem || /^(?:default(?:material)?\d*|lambert\d*|material\d*|blinn\d*)$/.test(stem)) return
  const matches = suffix => images.filter(item => {
    const name = textureName(item)
    return suffix.test(name) && materialStem(name.replace(suffix, '')) === stem
  })
  const chooseColor = candidates => closest([...new Set(candidates.map(item => preferColoredImage(item, images)))], file)
  const color = chooseColor(matches(colorSuffix))
  if (color) {
    const alpha = companionTexture(color, images, opacitySuffix) ?? closest(matches(opacitySuffix), file)
    return { url: color.url, alphaUrl: alpha?.url, alphaTest: alpha ? .5 : undefined }
  }
  const byName = new Map()
  for (const item of images) {
    const name = textureName(item)
    if (!colorSuffix.test(name)) continue
    if (stem.length < 6 && materialStem(item.path.split('/').at(-2)) !== stem) continue
    const family = name.replace(colorSuffix, '').replace(/[ _.-]+[a-z\d]+$/i, '')
    if (materialStem(family) !== stem) continue
    const entries = byName.get(name.toLowerCase()) ?? []
    entries.push(item)
    byName.set(name.toLowerCase(), entries)
  }
  const variants = [...byName.values()].map(chooseColor).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  if (variants.length) return { url: variants[0].url, variants }
  if (file.url.startsWith('/local-files/')) {
    const plain = closest(images.filter(item => !isDataMap(item) && materialStem(textureName(item)) === stem), file)
    if (plain) return { url: plain.url }
  }
}

async function applyExternalTextures(model, file, files, unityMaterials, manager) {
  const bindings = file.materialTextures ?? {}
  const images = files.filter(item => item.kind === 'image' && (item.preview || convertedImages.has(item.ext)) &&
    !item.path.includes('/.unity-previews/'))
  const meshes = []
  const materialMeshes = new Map()
  const replacedTextures = new Set()
  const variantGroups = []
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
  const isVertexMask = (material, uses, url) => {
    if (file.ext !== 'fbx' || !material.vertexColors || !url) return false
    const color = imagesByUrl.get(new URL(url, location.origin).pathname)
    if (!color || !companionTexture(color, images, idSuffix) || !companionTexture(color, images, opacitySuffix)) return false
    const layers = [...uses].map(mesh => mesh.geometry.getAttribute('color')).filter(Boolean)
    return layers.length > 0 && layers.every(resemblesVertexMask)
  }
  await Promise.all([...materialMeshes.keys()].map(async material => {
    const key = material.name.trim().toLowerCase()
    const explicit = Object.hasOwn(bindings, key) ? bindings[key] : null
    const uses = materialMeshes.get(material)
    const [owner] = uses
    const meshNames = !Array.isArray(owner.material) ? new Set([...uses].map(mesh => mesh.name)) : new Set()
    const meshName = meshNames.size && new Set([...meshNames].map(materialStem)).size === 1 ? owner.name : ''
    const single = materialMeshes.size === 1 && file.url.startsWith('/local-files/')
    const findByName = () => findColorTexture(key, file, images) ??
      (meshName ? findColorTexture(meshName, file, images) : undefined) ??
      (single ? findColorTexture(file.name.slice(0, -(file.ext.length + 1)), file, images) : undefined)
    if (hasTextureImage(material.map) && !explicit?.remap) {
      if (isVertexMask(material, uses, textureUrl(material.map))) {
        material.vertexColors = false
        material.needsUpdate = true
      }
      if (!file.previewAlbedo) return
      const variants = findByName()?.variants
      if (!variants || variants.length < 2) return
      const saved = file.previewTextureNames ?? []
      const matches = variants.filter(item => saved.includes(item.name.toLowerCase()))
      const files = matches.length === 1 ? variants : [{ name: 'Исходная (FBX)' }, ...variants]
      const index = matches.length === 1 ? variants.indexOf(matches[0]) : 0
      const original = material.map
      replacedTextures.add(original)
      variantGroups.push({ material, files, index, loadTexture, original, originalIndex: index })
      return
    }
    const getNamed = name => Object.hasOwn(unityMaterials, name) ? unityMaterials[name] : []
    const named = closest(getNamed(key), file) ?? (key.startsWith('mi_') ? closest(getNamed('m_' + key.slice(3)), file) : null)
    const unityBinding = explicit ?? prefabTextures.get(material) ?? named
    const binding = unityBinding ?? findByName()
    if (!binding) return
    try {
      const texture = await loadTexture(binding.url)
      texture.colorSpace = THREE.SRGBColorSpace
      if (file.previewFormat === 'glb' || ['glb', 'gltf'].includes(file.ext)) texture.flipY = false
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      if (binding.scale?.every(Number.isFinite)) texture.repeat.fromArray(binding.scale)
      if (binding.offset?.every(Number.isFinite)) texture.offset.fromArray(binding.offset)
      if (material.map) replacedTextures.add(material.map)
      material.map = texture
      material.color?.setHex(0xffffff)
      // Unity shaders can use vertex colors as masks. The preview only has the flat albedo map.
      if ((unityBinding && file.ext === 'fbx') || isVertexMask(material, uses, binding.url)) material.vertexColors = false
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
      if (binding.variants?.length > 1) variantGroups.push({ material, files: binding.variants, loadTexture, index: 0 })
    } catch { /* keep the original material when its external texture cannot be decoded */ }
  }))
  for (const texture of replacedTextures) model.userData.replacedTextures.add(texture)
  return variantGroups
}

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

function normalizePreviewMaterials(model, file) {
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

async function loadObj(file, manager, findResource) {
  const loader = new OBJLoader(manager)
  const source = await new THREE.FileLoader(manager).loadAsync(file.preview)
  const base = new URL(file.preview, location.origin)
  const references = [...source.matchAll(/^[ \t]*mtllib[ \t]+([^\r\n]+)/gm)].map(([, value]) => value.trim())
  const materialFiles = new Set()
  const findMaterial = name => {
    const resource = findResource(name.replace(/^["']|["']$/g, ''), base)
    if (resource?.ext === 'mtl') materialFiles.add(resource.url)
    return resource?.ext === 'mtl'
  }
  for (const name of references) {
    if (findMaterial(name)) continue
    for (const part of name.match(/"[^"]+"|'[^']+'|\S+/g) ?? []) findMaterial(part)
  }
  if (!materialFiles.size) findMaterial(file.name.replace(/\.obj$/i, '.mtl'))
  const loaded = await Promise.allSettled([...materialFiles].map(url => new MTLLoader(manager).loadAsync(url)))
  const creators = loaded.filter(result => result.status === 'fulfilled').map(result => result.value)
  if (creators.length) loader.setMaterials({
    create: name => creators.find(creator => Object.hasOwn(creator.materialsInfo, name))?.create(name),
  })
  return loader.parse(source)
}

async function applyGltfTexture(model, binding, files, manager) {
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
      dispose(this.root)
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
    const { manager, findResource, settled, release } = resolveResources(file, files)
    let model
    let animations = []
    let variantGroups = []
    const type = file.previewFormat ?? file.ext
    const local = file.url.startsWith('/local-files/')
    try {
      if (type === 'gltf' || type === 'glb') {
        const draco = new DRACOLoader(manager)
        draco.setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/')
        const ktx2 = new KTX2Loader(manager).setTranscoderPath('/vendor/three/examples/jsm/libs/basis/').detectSupport(this.renderer)
        const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2)
        try {
          const loaded = await loader.loadAsync(file.preview)
          model = loaded.scene
          animations = loaded.animations
          if (file.previewTexture && request === this.request) await applyGltfTexture(model, file.previewTexture, files, manager)
        } finally {
          draco.dispose()
          ktx2.dispose()
        }
      } else if (type === 'fbx') {
        model = await new FBXLoader(manager).loadAsync(file.preview)
        animations = model.animations
      } else if (type === 'obj') {
        model = await loadObj(file, manager, findResource)
      } else if (type === 'dae') {
        const loaded = await new ColladaLoader(manager).loadAsync(file.preview)
        model = loaded.scene
        animations = model.animations ?? []
      } else if (type === '3ds' || type === '3mf') {
        const loader = type === '3ds' ? new TDSLoader(manager) : new ThreeMFLoader(manager)
        model = await loader.loadAsync(file.preview)
      } else if (type === 'stl' || type === 'ply') {
        const loader = type === 'stl' ? new STLLoader(manager) : new PLYLoader(manager)
        const geometry = await loader.loadAsync(file.preview)
        const vertexColors = geometry.hasAttribute('color')
        if (type === 'ply' && geometry.userData.hasPlyFaces === false) {
          const material = new THREE.PointsMaterial({ vertexColors, color: vertexColors ? 0xffffff : 0xc3cfb0,
            size: 2, sizeAttenuation: false })
          model = new THREE.Points(geometry, material)
        } else {
          if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
          const material = fallbackMaterial()
          material.vertexColors = vertexColors
          if (vertexColors) material.color.setHex(0xffffff)
          model = new THREE.Mesh(geometry, material)
        }
      } else {
        throw new Error('Для этого формата нужно отдельное приложение')
      }
      await settled()
      model.userData.replacedTextures = new Set()
      if (request === this.request) {
        if (type === 'fbx') normalizeFbx(model)
        if ((type === 'fbx' || type === 'glb' || type === 'gltf' || local) && files.some(item => item.kind === 'image')) {
          variantGroups = await applyExternalTextures(model, file, files, unityMaterials, manager)
        }
        if (type === 'fbx') normalizeFbxVertexColors(model)
        normalizePreviewMaterials(model, file)
      }
    } catch (error) {
      if (model) dispose(model)
      throw error
    } finally {
      await release()
    }
    if (request !== this.request) {
      dispose(model)
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
      dispose(model)
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
