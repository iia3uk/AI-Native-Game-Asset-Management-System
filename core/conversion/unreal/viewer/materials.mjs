import { readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileInfo, readBoundedText } from '../../../files/asset-files.mjs'
import { describeUnrealMaterial } from '../../../materials/unreal/describe.mjs'
import { viewerMaterialProperties, viewerMaterialSlots } from '../../../materials/unreal/viewer-properties.mjs'
import { embeddedPng } from '../../../files/png-structure.mjs'
import { publishPackedMap } from './packed-maps.mjs'

const MiB = 1024 ** 2
const key = path => path.normalize('NFC').toLowerCase()

async function publishTexture(asset, decoded, store, version, signal) {
  if (asset.exports.some(item => item.path && item.format === 'png' && item.role === 'texture')) return false
  const source = asset.sourcePath.replace(/\.uasset$/i, '.png')
  const file = await fileInfo(decoded, source)
  if (!file || file.info.size > 64 * MiB) return false
  const bytes = await readFile(file.path, { signal })
  const image = embeddedPng(bytes, 0)
  if (image?.end !== file.info.size) return false
  const { width, height } = image
  const artifact = await store.save('Textures/' + source, file, { from: asset.output, format: 'png',
    role: 'texture', status: 'converted', method: 'ue-viewer', converterVersion: version, metrics: { width, height },
    issues: ['unreal-viewer-texture-exported-from-decoded-mip'] })
  asset.exports.push(artifact)
  if (artifact.path) asset.status = 'converted'
  return !!artifact.path
}

export async function publishViewerMaterials({ targets, parameters, store, records, version, signal }) {
  const decoded = parameters.output
  const byPath = new Map(targets.map(asset => [key(asset.sourcePath), asset]))
  const byName = Map.groupBy(targets, asset => key(posix.basename(asset.sourcePath).slice(0, -7)))
  const resolve = path => byPath.get(key(path))
  const descriptions = new Map()
  const cache = new Map()
  const counts = { materialJson: 0, texturePng: 0, texturedGltf: 0, packedMaterials: 0, repackedMaps: 0 }
  for (const asset of targets) {
    signal?.throwIfAborted()
    if (await publishTexture(asset, decoded, store, version, signal)) counts.texturePng++
  }
  for (const asset of targets) {
    signal?.throwIfAborted()
    const stem = asset.sourcePath.slice(0, -7)
    const propsPath = stem + '.props.txt'
    const slotsPath = stem + '.mat'
    const props = await readBoundedText(decoded, propsPath, 512 * 1024)
    const slots = await readBoundedText(decoded, slotsPath, 64 * 1024)
    if (!props || !slots) continue
    const properties = viewerMaterialProperties(props)
    const description = describeUnrealMaterial({ asset, properties, slots: viewerMaterialSlots(slots), resolve, version })
    description.packedMap = await publishPackedMap(description, { cache, resolve, store,
      workspace: parameters.workspace, version, signal, counts })
    const dir = 'Materials/' + asset.id + '/'
    const entries = [
      ['bindings.json', 'json', 'material', JSON.stringify(description, null, 2) + '\n'],
      ['ue-viewer-properties.txt', 'txt', 'material-source', props],
      ['ue-viewer-textures.txt', 'txt', 'material-source', slots],
    ]
    const bytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry[3]), 0)
    if (await store.preflight(bytes)) continue
    for (const [name, format, role, content] of entries) {
      const scratch = join(parameters.workspace, asset.id + '-' + name)
      await writeFile(scratch, content, { flag: 'wx', signal })
      asset.exports.push(await store.save(dir + name, { path: scratch, info: { size: Buffer.byteLength(content) } },
        { from: asset.output, format, role, status: 'converted', method: 'ue-viewer', converterVersion: version,
          ...(role === 'material' && { issues: description.limitations }) }))
    }
    if (!asset.exports.some(item => item.path === dir + 'bindings.json')) continue
    asset.status = 'converted'
    counts.materialJson++
    if (description.packedMap?.path) counts.packedMaterials++
    if (description.packedMap?.issue) asset.issues.push(description.packedMap.issue)
    descriptions.set(asset.id, description)
    const parents = properties.parent ? [{ path: properties.parent, type: 'unreal-material-parent' }] : []
    const textures = properties.textures.map(({ name, path }) => ({ path, parameter: name, type: 'unreal-material-texture' }))
    for (const { path, type, parameter } of [...parents, ...textures]) {
      const target = resolve(path)
      records.dependencies.push({ source: asset.id, target: target?.id ?? null, path, type,
        status: target ? 'resolved' : 'missing', ...(parameter && { parameter }) })
    }
  }
  const publishedMaterial = asset => {
    const description = asset && descriptions.get(asset.id)
    return description ? { asset, description } : null
  }
  const material = name => {
    const matches = byName.get(key(name))
    if (matches?.length !== 1) return null
    return publishedMaterial(matches[0])
  }
  return { counts, material, lookupBySourcePath: path => publishedMaterial(resolve(path)) }
}
