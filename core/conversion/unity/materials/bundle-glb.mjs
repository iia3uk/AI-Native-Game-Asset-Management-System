import { readFile, writeFile } from 'node:fs/promises'
import { fileInfo } from '../../../files/asset-files.mjs'
import { encodeGlb } from '../../glb.mjs'
import { bundleTarget } from './bundle-material.mjs'

const limit = 32 * 1024 ** 2
const transform = 'KHR_texture_transform'
const unit = value => Math.max(0, Math.min(1, value))
const linearColor = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4

function parts(bytes) {
  if (bytes.length < 28) return null
  const end = 20 + bytes.readUInt32LE(12)
  if (bytes.length < end + 8 || bytes.toString('ascii', 16, 20) !== 'JSON' ||
      bytes.toString('ascii', end + 4, end + 8) !== 'BIN\0' || bytes.readUInt32LE(end) !== bytes.length - end - 8) return null
  const document = JSON.parse(bytes.toString('utf8', 20, end))
  const data = bytes.subarray(end + 8)
  return { document, data }
}

function addTransform(info, slot, document) {
  const [sx, sy] = slot.scale
  const [ox, oy] = slot.offset
  if (sx === 1 && sy === 1 && ox === 0 && oy === 0) return
  // The worker flipped V when it wrote TEXCOORD_0.
  info.extensions = { [transform]: { scale: [sx, sy], offset: [ox, 1 - sy - oy] } }
  document.extensionsUsed = [transform]
}

export async function applyBundleMaterials(file, entry, output, objects, budget, signal) {
  const bindings = entry.meshMaterials
  if (bindings.status !== 'linked') return bindings.status
  const bytes = await readFile(file.path, { signal })
  const model = parts(bytes)
  const primitives = model?.document.meshes?.[0]?.primitives
  if (model?.document.meshes?.length !== 1 || !Array.isArray(primitives) || primitives.length !== bindings.slots.length ||
      model.document.buffers?.length !== 1 || !Array.isArray(model.document.bufferViews)) return 'slot-count'
  const { document, data } = model
  const images = new Map()
  const materials = new Map()
  const gltfMaterials = []
  const gltfImages = []
  const gltfTextures = []
  const buffers = [data]
  let binarySize = data.length
  let mapsBytes = 0
  let complete = true
  for (const [index, reference] of bindings.slots.entries()) {
    signal?.throwIfAborted()
    const source = bundleTarget(objects, bindings.rendererMember ?? entry.member, reference, 21)
    const material = source?.material
    const mode = material?.numbers._Mode ?? 0
    if (material?.profile !== 'standard' || (mode !== 0 && mode !== 1)) {
      complete = false
      continue
    }
    const primitive = primitives[index]
    const textured = primitive.attributes?.TEXCOORD_0 !== undefined
    const key = source.id + ':' + textured
    if (!materials.has(key)) {
      const color = (material.color ?? [1, 1, 1, 1]).map(unit)
      const pbr = { baseColorFactor: color.map((value, channel) => channel < 3 ? linearColor(value) : value),
        metallicFactor: unit(material.numbers._Metallic ?? 0), roughnessFactor: 1 - unit(material.numbers._Glossiness ?? .5) }
      const preview = { name: source.name, pbrMetallicRoughness: pbr }
      if (mode === 1) Object.assign(preview, { alphaMode: 'MASK', alphaCutoff: unit(material.numbers._Cutoff ?? .5) })
      const slot = material.textures.find(item => item.property === '_MainTex')
      if (material.textures.some(item => item !== slot)) complete = false
      if (slot) {
        const texture = bundleTarget(objects, source.member, slot.texture, 28)
        if (textured && texture && texture.textureColorSpace === 'srgb') {
          const image = await addTexture(texture)
          if (image !== undefined) {
            pbr.baseColorTexture = { index: image }
            addTransform(pbr.baseColorTexture, slot, document)
          } else complete = false
        } else complete = false
      }
      materials.set(key, gltfMaterials.length)
      gltfMaterials.push(preview)
    }
    primitive.material = materials.get(key)
  }
  if (!materials.size) return 'unavailable'
  document.materials = gltfMaterials
  if (gltfImages.length) {
    document.images = gltfImages
    document.textures = gltfTextures
  }
  document.buffers[0].byteLength = binarySize
  await writeFile(file.path, encodeGlb(document, buffers, binarySize), { signal })
  budget.remaining -= mapsBytes
  return complete ? 'bound' : 'partial'

  async function addTexture(texture) {
    const path = texture.artifact.path
    if (images.has(path)) return images.get(path)
    const source = await fileInfo(output, path)
    if (!source || source.info.size !== texture.artifact.size ||
        source.info.size > Math.min(limit, budget.remaining) - mapsBytes) return undefined
    const png = await readFile(source.path, { signal })
    if (png.length !== source.info.size) return undefined
    const padding = (4 - png.length % 4) % 4
    const bufferView = document.bufferViews.length
    document.bufferViews.push({ buffer: 0, byteOffset: binarySize, byteLength: png.length })
    const index = images.size
    gltfImages.push({ name: texture.name, bufferView, mimeType: 'image/png' })
    gltfTextures.push({ source: index })
    buffers.push(png, Buffer.alloc(padding))
    binarySize += png.length + padding
    mapsBytes += png.length
    images.set(path, index)
    return index
  }
}
