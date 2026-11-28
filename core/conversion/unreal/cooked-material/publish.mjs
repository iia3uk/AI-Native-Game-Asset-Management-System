import { writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { describeUnrealMaterial } from '../../../materials/unreal/describe.mjs'
import { sourceMaterialParameters } from '../../../materials/unreal/source-parameters.mjs'
import { pakMaterialResolver } from './pak-inputs.mjs'

export const cookedMaterialRevision = 1
const method = 'unreal-cooked-material-properties'

function materialLinks(asset, description, resolve) {
  const records = []
  const seen = new Set()
  const add = (path, type, parameter) => {
    if (!path) return
    const key = JSON.stringify([type, path, parameter])
    if (seen.has(key)) return
    seen.add(key)
    const target = resolve(path)
    records.push({ type, source: asset.id, path, target: target?.id ?? null, status: target ? 'resolved' : 'missing',
      ...(parameter && { parameter }) })
  }
  add(description.parent, 'unreal-material-parent')
  for (const { path, name } of [...description.parameters.textures, ...description.effectiveParameters.textures]) add(path, 'unreal-material-texture', name)
  for (const { path } of description.textureStreaming) {
    if (!records.some(row => row.path === path)) add(path, 'unreal-material-texture')
  }
  return records
}

export async function publishPakMaterials(assets, { results, incomplete }, workspace, store, signal) {
  const dependencies = []
  const materials = { converted: 0, skipped: 0, failed: 0,
    ...(incomplete && { issue: 'unreal-cooked-material-budget' }) }
  const resolveAsset = pakMaterialResolver(assets)
  const sidecars = new Map(assets.filter(asset => asset.format === 'uexp' && asset.artifact?.path)
    .map(asset => [asset.path.normalize('NFC').toLowerCase(), asset]))
  const parsed = new Map()
  for (const asset of assets) {
    const material = results.get(asset.path)?.material
    if (material && asset.artifact?.path) parsed.set(asset.id, material)
  }
  for (const asset of assets) {
    signal?.throwIfAborted()
    const result = results.get(asset.path)
    if (!result || !asset.artifact?.path) continue
    const details = { from: asset.artifact.path, format: 'json', role: 'material', method, converterVersion: cookedMaterialRevision }
    const companion = result.split ? sidecars.get(asset.path.normalize('NFC').toLowerCase().slice(0, -7) + '.uexp') : null
    const issue = result.issue ?? (result.split && !companion ? 'unreal-cooked-material-export-missing' : null)
    const exported = issue ? { ...details, status: 'skipped', issue } :
      await publishDescription(asset, companion, parsed, resolveAsset, dependencies, workspace, store, details, signal)
    asset.exports ??= []
    asset.exports.push(exported)
    materials[exported.status]++
  }
  return { materials, dependencies }
}

async function publishDescription(asset, companion, parsed, resolveAsset, dependencies, workspace, store, details, signal) {
  const source = parsed.get(asset.id)
  const resolve = reference => resolveAsset(asset.path, reference)
  const resolveMaterial = reference => {
    const target = resolve(reference)
    return target && { id: target.id, sourcePath: target.path }
  }
  const effective = sourceMaterialParameters({ id: asset.id, sourcePath: asset.path }, parsed, resolveMaterial)
  const { parentStatus, corroborate, surface } = effective
  const effectiveParameters = { textures: effective.textures, scalars: effective.scalars, vectors: effective.vectors }
  const properties = { parent: source.parent, textures: effectiveParameters.textures.filter(row => row.path),
    scalars: effectiveParameters.scalars.filter(row => Number.isFinite(row.value)) }
  const description = describeUnrealMaterial({ asset: { sourcePath: asset.path, hash: asset.artifact.sha256 }, properties,
    resolve: path => {
      const target = resolve(path)
      return target && { id: target.id, exports: target.exports ?? [] }
    }, method, version: cookedMaterialRevision, corroborate })
  for (const binding of description.bindings) {
    const texture = resolve(binding.sourcePath)?.exports?.find(file => file.path === binding.path)
    if (typeof texture?.srgb === 'boolean') binding.textureColorSpace = texture.srgb ? 'sRGB' : 'linear'
  }
  if (companion) description.source.payload = { path: companion.path, sha256: companion.artifact.sha256 }
  const { textures, scalars, vectors } = source
  Object.assign(description, { materialClass: source.type, parentStatus, parameters: { textures, scalars, vectors },
    effectiveParameters, textureStreaming: source.streaming, ...(surface && { surface }) })
  description.limitations.push('unreal-cooked-material-shader-data')
  const content = JSON.stringify(description, null, 2) + '\n'
  const size = Buffer.byteLength(content)
  const error = await store.preflight(size)
  if (error) return { ...details, status: 'failed', issue: error }
  const path = join(workspace, asset.id + '.json')
  await writeFile(path, content, { signal, flag: 'wx' })
  const name = posix.basename(asset.path).slice(0, -7) + '.material.json'
  const artifact = await store.save('Materials/' + asset.id + '/' + name, { path, info: { size } },
    { ...details, status: 'converted', issues: description.limitations })
  if (artifact.path) dependencies.push(...materialLinks(asset, description, resolve))
  return artifact
}
