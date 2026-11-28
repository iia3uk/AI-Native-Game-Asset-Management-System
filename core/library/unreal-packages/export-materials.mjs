import { posix } from 'node:path'
import { streamingColor } from '../../materials/unreal/streaming-color.mjs'
import { packageHashPattern } from '../../packages/source.mjs'
import { catalogArtifactPath, catalogJson } from './documents.mjs'
import { convertedArtifacts, textureFile } from './texture-products.mjs'

const limit = 1024 ** 2
const assetId = /^[a-f\d]{32}$/
const roleModel = new Set(['model', 'skeletal-model'])
const array = (value, max) => Array.isArray(value) && value.length <= max ? value : []
const key = name => name.normalize('NFC').toLowerCase()

function packageMatch(path, asset) {
  const source = asset.sourcePath
  if (typeof path !== 'string' || !path.startsWith('/Game/') || !catalogArtifactPath(path.slice(6)) ||
      typeof source !== 'string' || !/\.uasset$/i.test(source) || !catalogArtifactPath(source)) return false
  const mountPath = key(path.slice(6))
  const relative = key(source.slice(0, -7))
  return mountPath === relative || mountPath.endsWith('/' + relative)
}

function modelMaterialLinks(links, byId, lod) {
  return [...new Set(links.filter(link => link.type === 'unreal-model-material' && link.lod === lod &&
    byId.get(link.target)?.sourcePath === link.path).map(link => byId.get(link.target)))]
}

export async function attachExportMaterials(root, { prefix, manifest }, files, siblingTexture) {
  const byId = new Map()
  for (const asset of manifest.assets) {
    if (!assetId.test(asset?.id) || byId.has(asset.id)) return
    byId.set(asset.id, asset)
  }
  const models = files.some(file => file.ext === 'glb' || file.ext === 'gltf')
  if (!models) return
  const dependencyHash = manifest.dependenciesSha256
  if (dependencyHash !== undefined && !packageHashPattern.test(dependencyHash)) return
  const dependencies = await catalogJson(root, posix.join(prefix, 'dependencies.json'), 8 * limit, dependencyHash)
  const links = Map.groupBy(array(dependencies?.dependencies, 40_000).filter(link =>
    link?.status === 'resolved' && byId.has(link.source) && byId.has(link.target)), link => link.source)
  if (!links.size) return

  const byPath = new Map(files.map(file => [file.path, file]))
  const borrowed = new Map()
  const fileFor = item => {
    const file = byPath.get(posix.join(prefix, item.path))
    return file?.size === item.size ? file : null
  }
  const documents = new Map()
  function document(item) {
    if (!item || !packageHashPattern.test(item.sha256) || item.size > limit) return null
    const path = posix.join(prefix, item.path)
    if (!documents.has(path) && documents.size < 2048) documents.set(path, catalogJson(root, path, limit, item.sha256))
    return documents.get(path)
  }
  const materialCache = new Map()
  async function getMaterial(asset) {
    if (materialCache.has(asset.id)) return materialCache.get(asset.id)
    const product = convertedArtifacts(asset).find(item => item.role === 'material' && item.format === 'json' &&
      item.path === 'Materials/' + asset.id + '/bindings.json')
    const description = await document(product)
    if (description?.source?.engine !== 'unreal' || description.source.path !== asset.sourcePath ||
        description.source.sha256 !== asset.hash) {
      materialCache.set(asset.id, null)
      return null
    }
    const textures = new Map()
    const edges = (links.get(asset.id) ?? []).filter(link => link.type === 'unreal-material-texture')
    for (const [path, matches] of Map.groupBy(edges, link => link.path)) {
      const targets = new Set(matches.map(link => byId.get(link.target)).filter(target => packageMatch(path, target)))
      if (targets.size !== 1) continue
      const [target] = targets
      const products = convertedArtifacts(target).filter(item => item.role === 'texture')
      if (products.length !== 1) continue
      const [artifact] = products
      const file = textureFile(fileFor(artifact), artifact) ?? siblingTexture(target, prefix)
      if (file) textures.set(path, { ...artifact, file })
    }
    const related = [...new Set([...textures.values()].map(item => item.file))]
    const explicit = new Set(array(description.bindings, 256).filter(item => item?.role === 'baseColor' && item.corroborated)
      .map(item => item.path))
    const [base] = explicit
    const color = explicit.size ? (explicit.size === 1 && [...textures.values()].find(item => item.path === base)) :
      streamingColor(description, path => textures.get(path))
    const result = { related, color: color && color.file }
    materialCache.set(asset.id, result)
    return result
  }

  for (const asset of manifest.assets) {
    const edges = links.get(asset.id)
    if (!edges?.some(link => link.type === 'unreal-model-material')) continue
    const products = convertedArtifacts(asset).filter(item => roleModel.has(item.role))
    const gltfs = new Map(products.filter(item => item.format === 'gltf').map(item => [item.path, item]))
    for (const product of products) {
      if (!['gltf', 'glb'].includes(product.format)) continue
      const file = fileFor(product)
      const candidates = modelMaterialLinks(edges, byId, product.lod)
      if (file?.kind !== 'model' || !candidates.length) continue
      const source = product.format === 'gltf' ? product : gltfs.get(product.from)
      const sourceDocument = await document(source)
      const bindings = Object.create(null)
      const related = new Set()
      const named = new Set()
      for (const slot of array(sourceDocument?.materials, 128)) {
        if (typeof slot?.name !== 'string' || slot.name.length > 128) continue
        const targets = candidates.filter(target => packageMatch(slot.extras?.unrealMaterial, target))
        if (targets.length !== 1) continue
        const material = await getMaterial(targets[0])
        if (!material) continue
        for (const texture of material.related) {
          related.add(texture.id)
          if (!byPath.has(texture.path)) borrowed.set(texture.id, texture)
        }
        const name = key(slot.name.trim())
        if (named.has(name)) delete bindings[name]
        else if (material.color) bindings[name] = { url: material.color.url }
        named.add(name)
      }
      if (related.size) file.relatedTextures = [...related]
      if (Object.keys(bindings).length) file.materialTextures = bindings
    }
  }
  files.push(...borrowed.values())
}
