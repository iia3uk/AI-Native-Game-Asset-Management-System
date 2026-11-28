import { readFile, writeFile } from 'node:fs/promises'
import { encodeGlb } from '../../glb.mjs'
import { bundleImages } from './bundle-image.mjs'
import { bundleTarget } from './bundle-material.mjs'
import { standardPreview } from './standard-preview.mjs'

function parts(bytes) {
  if (bytes.length < 28) return null
  const end = 20 + bytes.readUInt32LE(12)
  if (bytes.length < end + 8 || bytes.toString('ascii', 16, 20) !== 'JSON' ||
      bytes.toString('ascii', end + 4, end + 8) !== 'BIN\0' || bytes.readUInt32LE(end) !== bytes.length - end - 8) return null
  const document = JSON.parse(bytes.toString('utf8', 20, end))
  const data = bytes.subarray(end + 8)
  return { document, data }
}

export async function applyBundleMaterials(file, entry, output, objects, budget, signal) {
  const bindings = entry.meshMaterials
  if (bindings.status !== 'linked') return { status: bindings.status }
  const bytes = await readFile(file.path, { signal })
  const model = parts(bytes)
  const primitives = model?.document.meshes?.[0]?.primitives
  if (model?.document.meshes?.length !== 1 || !Array.isArray(primitives) || primitives.length !== bindings.slots.length ||
      model.document.buffers?.length !== 1 || !Array.isArray(model.document.bufferViews)) return { status: 'slot-count' }
  const { document, data } = model
  const images = bundleImages(document, data, budget)
  const materials = new Map()
  const gltfMaterials = []
  const issues = new Set()
  const channels = new Set()
  const extensions = new Set(document.extensionsUsed)
  for (const [index, reference] of bindings.slots.entries()) {
    signal?.throwIfAborted()
    const source = bundleTarget(objects, bindings.rendererMember ?? entry.member, reference, 21)
    const material = source?.material
    const mode = material?.numbers._Mode ?? 0
    if (material?.profile !== 'standard' || (mode !== 0 && mode !== 1)) {
      issues.add(!source ? 'material-reference-missing' : 'unsupported-shader-or-alpha')
      continue
    }
    const primitive = primitives[index]
    const uv = primitive.attributes?.TEXCOORD_0 !== undefined
    const tangent = primitive.attributes?.TANGENT !== undefined && primitive.attributes?.NORMAL !== undefined
    const key = source.id + ':' + uv + ':' + tangent
    if (!materials.has(key)) {
      const material = await standardPreview(source, primitive, { output, objects, images, extensions, signal })
      for (const issue of material.issues) issues.add(issue)
      for (const channel of material.channels) channels.add(channel)
      materials.set(key, gltfMaterials.length)
      gltfMaterials.push(material.preview)
    }
    primitive.material = materials.get(key)
  }
  if (!materials.size) return { status: 'unavailable', issues: [...issues] }
  document.materials = gltfMaterials
  if (extensions.size) document.extensionsUsed = [...extensions]
  const { binarySize, mapsBytes } = images.finish()
  await writeFile(file.path, encodeGlb(document, images.buffers, binarySize), { signal })
  budget.remaining -= mapsBytes
  return {
    status: issues.size ? 'partial' : 'bound', issues: [...issues], channels: [...channels],
    alphaCutout: gltfMaterials.some(material => material.alphaMode === 'MASK'),
  }
}
