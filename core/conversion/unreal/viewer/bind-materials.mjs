import { writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { readBoundedText } from '../../../files/asset-files.mjs'

function singleMap(description, role) {
  const maps = description.bindings.filter(binding => binding.role === role && binding.corroborated && binding.path)
  const paths = new Set(maps.map(binding => binding.path))
  return paths.size === 1 ? maps[0].path : null
}

function scalar(description, name, max) {
  const values = new Set(description.scalars.filter(row => row.name.toLowerCase() === name).map(row => row.value))
  const [value] = values
  return values.size === 1 && value >= 0 && value <= max ? value : null
}

export function bindViewerMaterials(document, lookup, modelPath) {
  if (!Array.isArray(document.materials) || !document.materials.length || document.materials.length > 128 ||
      document.images || document.textures) return null
  const sources = new Set()
  const images = new Map()
  const usable = new Map()
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const uv0 = Number.isSafeInteger(primitive.attributes?.TEXCOORD_0)
      usable.set(primitive.material, usable.get(primitive.material) !== false && uv0)
    }
  }
  const image = path => {
    const index = images.get(path)
    if (index !== undefined) return { index }
    if (images.size >= 120) return null
    const uri = posix.relative(posix.dirname(modelPath), path).split('/').map(encodeURIComponent).join('/')
    images.set(path, images.size)
    document.images ??= []
    document.textures ??= []
    document.images.push({ uri })
    document.textures.push({ source: images.size - 1 })
    return { index: images.size - 1 }
  }
  for (const [index, material] of document.materials.entries()) {
    if (!material?.name || typeof material.name !== 'string') continue
    const match = lookup(material.name)
    if (!match) continue
    const { asset, description } = match
    sources.add(asset)
    if (!usable.get(index) || !material.pbrMetallicRoughness) continue
    const color = singleMap(description, 'baseColor')
    const emissive = singleMap(description, 'emissive')
    const baseColorTexture = color && image(color)
    const emissiveTexture = emissive && image(emissive)
    if (!baseColorTexture && !emissiveTexture) continue
    const pbr = material.pbrMetallicRoughness
    if (baseColorTexture) {
      pbr.baseColorTexture = baseColorTexture
      pbr.baseColorFactor = [1, 1, 1, 1]
    }
    if (emissiveTexture) {
      material.emissiveTexture = emissiveTexture
      const strength = scalar(description, 'emissiveintensity', 100) ?? 1
      material.emissiveFactor = [1, 1, 1].map(value => value * Math.min(1, strength))
      if (strength > 1) {
        const extension = 'KHR_materials_emissive_strength'
        document.extensionsUsed = [...new Set([...(document.extensionsUsed ?? []), extension])]
        material.extensions = { ...material.extensions, [extension]: { emissiveStrength: strength } }
      }
    }
    pbr.metallicFactor = scalar(description, 'metallic', 1) ?? 0
    pbr.roughnessFactor = scalar(description, 'roughness', 1) ?? .5
  }
  return { sources, images: images.size }
}

export async function publishTexturedViewerModels({ models, material, counts, records, output, workspace, store, signal }) {
  for (const { asset, artifact } of models) {
    signal?.throwIfAborted()
    const text = await readBoundedText(output, artifact.path, 16 * 1024 ** 2)
    if (!text) continue
    const document = JSON.parse(text)
    const result = bindViewerMaterials(document, material, artifact.path)
    if (!result) continue
    for (const source of result.sources) {
      records.dependencies.push({ source: asset.id, target: source.id, path: source.sourcePath,
        type: 'unreal-model-material', status: 'resolved', lod: artifact.lod })
    }
    if (!result.images) continue
    const path = artifact.path.replace(/\.gltf$/, '-materials.gltf')
    const scratch = join(workspace, 'viewer-material-model.gltf')
    const content = JSON.stringify(document)
    const size = Buffer.byteLength(content)
    const issue = size > 16 * 1024 ** 2 ? 'unreal-material-model-size-limit' : await store.preflight(size)
    if (issue) {
      asset.issues.push(issue)
      continue
    }
    await writeFile(scratch, content, { flag: 'w', signal })
    const { format, role, lod, metrics, converterVersion } = artifact
    const textured = await store.save(path, { path: scratch, info: { size } }, {
      format, role, lod, metrics, converterVersion, status: 'converted', from: artifact.path,
      images: result.images, method: 'ue-viewer-material-binding',
      issues: ['unreal-material-preview-approximate'],
    })
    asset.exports.push(textured)
    if (textured.path) counts.texturedGltf++
  }
}
