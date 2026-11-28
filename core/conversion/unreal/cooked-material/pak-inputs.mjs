import { readCookedMaterials } from './read.mjs'

const key = path => path.normalize('NFC').toLowerCase()
const projectContent = /^([^/]+)\/content\//

export function readPakMaterials(entries, accepted, root, signal) {
  const byPath = new Map(entries.filter(entry => entry.format === 'uexp' && accepted.has(entry))
    .map(entry => [key(entry.path), accepted.get(entry)]))
  const maps = new Set(entries.filter(entry => entry.format === 'umap' && accepted.has(entry))
    .map(entry => key(entry.path).slice(0, -5)))
  const inputs = entries.filter(entry => entry.format === 'uasset' && accepted.has(entry)).map(entry => {
    const stem = key(entry.path).slice(0, -7)
    return { path: entry.path, header: accepted.get(entry), companion: maps.has(stem) ? null : byPath.get(stem + '.uexp') }
  })
  return readCookedMaterials(inputs, root, signal)
}

export function pakMaterialResolver(assets) {
  const packages = new Map(assets.filter(asset => asset.format === 'uasset' && asset.artifact?.path)
    .map(asset => [key(asset.path), asset]))
  return (from, path) => {
    const own = key(from).match(projectContent)
    if (!own || own[1] === 'engine' || !path.startsWith('/Game/')) return null
    return packages.get(own[0] + key(path.slice(6)) + '.uasset') ?? null
  }
}
