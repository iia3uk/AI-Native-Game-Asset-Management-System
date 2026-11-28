import { readCookedMaterial } from '../../../engines/unreal/cooked-package/material.mjs'

const key = path => path.normalize('NFC').toLowerCase()
const projectContent = /^([^/]+)\/content\//

export async function readPakMaterials(entries, accepted, root, signal) {
  const byPath = new Map(entries.filter(entry => entry.format === 'uexp' && accepted.has(entry))
    .map(entry => [key(entry.path), accepted.get(entry)]))
  const maps = new Set(entries.filter(entry => entry.format === 'umap' && accepted.has(entry))
    .map(entry => key(entry.path).slice(0, -5)))
  const results = new Map()
  const deadline = Date.now() + 30_000
  let parameters = 0
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (entry.format !== 'uasset' || !accepted.has(entry)) continue
    if (Date.now() >= deadline || results.size >= 1024) return { results, incomplete: true }
    const stem = key(entry.path).slice(0, -7)
    const result = await readCookedMaterial(root, accepted.get(entry), maps.has(stem) ? null : byPath.get(stem + '.uexp'), signal)
    if (!result) continue
    const material = result.material
    if (material) parameters += material.textures.length + material.scalars.length + material.vectors.length + material.streaming.length
    if (parameters > 16384) return { results, incomplete: true }
    results.set(entry.path, result)
  }
  return { results, incomplete: false }
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
