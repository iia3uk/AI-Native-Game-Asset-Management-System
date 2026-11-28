import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readSourceMaterial, sourceMaterialRevision, sourceMaterialVersions } from '../../../engines/unreal/source-material/properties.mjs'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { describeUnrealMaterial } from '../../../materials/unreal/describe.mjs'
import { sourceMaterialParameters } from '../../../materials/unreal/source-parameters.mjs'
import { publishPackedMap } from '../viewer/packed-maps.mjs'
import { publishSourceNormal } from './normal-map.mjs'
import { publishSourceOpacity } from './opacity-mask.mjs'

const method = 'unreal-editor-material-properties'
const maxPackageSize = 8 * 1024 ** 2

async function readMaterials(assets, output, signal) {
  const parsed = new Map()
  const deadline = Date.now() + 35_000
  for (const asset of assets) {
    signal?.throwIfAborted()
    if (!asset.output || asset.issue || asset.type !== 'uasset' || asset.storage !== 'editor' ||
        asset.layout !== -7 || !sourceMaterialVersions.has(asset.ue4) || asset.ue5 !== 0 || asset.size > maxPackageSize) continue
    if (Date.now() >= deadline) return { parsed, issue: 'unreal-source-material-time-budget' }
    const changed = () => new Error('Staged Unreal package changed during material decoding')
    const file = await fileInfo(output, asset.output)
    if (!file || file.info.size !== asset.size) throw changed()
    const { prefix, hash } = await readVerifiedFile(output, file, { capture: asset.size, changed, signal })
    if (hash !== asset.hash) throw changed()
    try {
      const properties = readSourceMaterial(prefix, asset.ue4)
      if (properties) parsed.set(asset.id, properties)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
    }
  }
  return { parsed }
}

function addDependencies(records, asset, description, resolve) {
  const links = description.parent ? [{ path: description.parent, type: 'unreal-material-parent' }] : []
  const seen = new Set()
  for (const row of [...description.parameters.textures, ...description.effectiveParameters.textures]) {
    if (!row.path) continue
    const key = JSON.stringify([row.name, row.path])
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ path: row.path, type: 'unreal-material-texture', parameter: row.name })
  }
  for (const row of description.textureStreaming) {
    if (row.path && !links.some(link => link.path === row.path)) links.push({ path: row.path, type: 'unreal-material-texture' })
  }
  for (const path of [description.normalMap?.sourcePath, description.opacityMask?.sourcePath, description.opacityMask?.colorSourcePath]) {
    if (path && !links.some(link => link.path === path)) links.push({ path, type: 'unreal-material-texture' })
  }
  for (const link of links) {
    const target = resolve(link.path)
    records.dependencies.push({ ...link, source: asset.id, target: target?.id ?? null,
      status: target ? 'resolved' : 'missing' })
  }
}

export async function prepareSourceMaterials({ records, output, workspace, signal, store, resolve }) {
  const { parsed, issue } = await readMaterials(records.assets, output, signal)
  const summary = { converterVersion: sourceMaterialRevision, materialJson: 0, packedMaterials: 0, repackedMaps: 0,
    normalMaterials: 0, normalDerivatives: 0, opacityMaterials: 0, opacityDerivatives: 0, ...(issue && { issue }) }
  const scratch = join(workspace, 'unreal-source-material')
  await mkdir(scratch)
  const normalCache = new Map()
  const opacityCache = new Map()
  const resolveFor = asset => path => resolve(path, asset)
  const parameters = asset => parsed.has(asset.id) ? sourceMaterialParameters(asset, parsed, resolveFor(asset)) : null
  const applySourceMaps = async (description, asset, { normal, surface } = parameters(asset) ?? {}) => {
    const resolve = resolveFor(asset)
    const map = await publishSourceNormal(normal, { store, resolve, workspace: scratch, cache: normalCache,
      version: sourceMaterialRevision, signal, summary })
    if (map) {
      description.normalMap = map
      description.limitations = description.limitations.filter(issue => issue !== 'normal-orientation-unverified')
      summary.normalMaterials++
    }
    if (surface) description.surface = surface
    const opacity = await publishSourceOpacity(surface, { store, resolve, workspace: scratch, cache: opacityCache,
      version: sourceMaterialRevision, signal, summary })
    if (opacity) {
      description.opacityMask = opacity
      summary.opacityMaterials++
      if (!opacity.colorImage) description.limitations.push('unreal-opacity-mask-neutral-color')
    } else if (surface?.blend === 'BLEND_Masked') description.limitations.push('unreal-opacity-mask-unresolved')
  }
  return { parsed, parameters, applySourceMaps, resolveFor, scratch, summary }
}

export async function publishSourceMaterials({ records, signal, store, cache, sourceMaterials }) {
  const { parsed, parameters, applySourceMaps, resolveFor, scratch, summary } = sourceMaterials
  const published = new Map()
  for (const asset of records.assets) {
    signal?.throwIfAborted()
    const source = parsed.get(asset.id)
    if (!source || asset.exports.some(item => item.path && item.role === 'material' && item.format === 'json')) continue
    const resolve = resolveFor(asset)
    const { parentStatus, corroborate, normal, surface, ...effectiveParameters } = parameters(asset)
    const properties = { parent: source.parent, textures: effectiveParameters.textures.filter(row => row.path),
      scalars: effectiveParameters.scalars.filter(row => Number.isFinite(row.value)) }
    const description = describeUnrealMaterial({ asset, properties, resolve, method, version: sourceMaterialRevision, corroborate })
    const { textures, scalars, vectors } = source
    Object.assign(description, { materialClass: source.type, parentStatus, parameters: { textures, scalars, vectors },
      effectiveParameters, textureStreaming: source.streaming, ...(source.normalInput && { normalInput: source.normalInput }) })
    await applySourceMaps(description, asset, { normal, surface })
    description.packedMap = await publishPackedMap(description, { cache, resolve, store, workspace: scratch,
      version: sourceMaterialRevision, signal, counts: summary })
    const content = JSON.stringify(description, null, 2) + '\n'
    const size = Buffer.byteLength(content)
    const preflight = await store.preflight(size)
    if (preflight) {
      asset.issues.push(preflight)
      summary.issue ??= preflight
      continue
    }
    const path = join(scratch, asset.id + '-bindings.json')
    await writeFile(path, content, { flag: 'wx', signal })
    const artifact = await store.save('Materials/' + asset.id + '/bindings.json', { path, info: { size } }, {
      from: asset.output, status: 'converted', format: 'json', role: 'material', method, converterVersion: sourceMaterialRevision,
      issues: description.limitations,
    })
    asset.exports.push(artifact)
    if (!artifact.path) {
      summary.issue ??= artifact.issue
      continue
    }
    published.set(asset.id, { asset, description })
    asset.status = 'converted'
    summary.materialJson++
    if (description.packedMap?.path) summary.packedMaterials++
    if (description.packedMap?.issue) asset.issues.push(description.packedMap.issue)
    addDependencies(records, asset, description, resolve)
  }
  return { summary, material: asset => published.get(asset.id) }
}
