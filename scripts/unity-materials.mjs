import { readBoundedText } from '../core/asset-files.mjs'
import { prefabMeshes } from './unity-prefabs.mjs'

const textureFormats = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tga', 'tif', 'tiff', 'avif'])
const colorSlots = ['_BaseMap', '_BaseColorMap', '_MainTex', '_AlbedoMap']
const unquote = value => value.trim().replace(/^(['"])(.*)\1$/, '$2')
const materialKey = value => unquote(value).toLowerCase()
const modelStem = file => file.name.replace(/\.[^.]+$/, '').replace(/[ _.-]low$/i, '').toLowerCase()

function nearby(candidates, source) {
  if (candidates.length < 2) return candidates[0]
  const sourceParts = source.path.toLowerCase().split('/').slice(0, -1)
  const score = candidate => {
    const parts = candidate.file.path.toLowerCase().split('/').slice(0, -1)
    let prefix = 0
    while (prefix < sourceParts.length && sourceParts[prefix] === parts[prefix]) prefix++
    return prefix * 100 - (sourceParts.length + parts.length - 2 * prefix)
  }
  const ordered = [...candidates].sort((a, b) => score(b) - score(a))
  if (score(ordered[0]) > score(ordered[1])) return ordered[0]
}

function add(map, key, value) {
  if (!key) return
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}

function textureBinding(entry, textures) {
  const { file, content } = entry
  const slots = new Map()
  for (const match of content.matchAll(/^ +-[ \t]+(\w+):[ \t]*\r?\n([ \t]+m_Texture:[^\r\n]*(?:\r?\n[ \t]+m_(?:Scale|Offset):[^\r\n]*)*)/gm)) {
    const [, slot, fields] = match
    const guid = fields.match(/\bguid:[ \t]*([\da-f]{32})\b/i)?.[1]?.toLowerCase()
    const texture = nearby(textures.get(guid) ?? [], file)
    if (!texture) continue
    const vector = name => fields.match(new RegExp(`m_${name}:[ \\t]*\\{x:[ \\t]*([^,]+), y:[ \\t]*([^}]+)\\}`))?.slice(1).map(Number)
    slots.set(slot, { url: texture.file.url, scale: vector('Scale'), offset: vector('Offset') })
  }
  const binding = colorSlots.map(slot => slots.get(slot)).find(Boolean)
  if (!binding) return
  if (/_ALPHATEST_ON|^[ \t]*-[ \t]+_AlphaClip:[ \t]*1\s*$/m.test(content)) {
    binding.alphaTest = Number(content.match(/^[ \t]*-[ \t]+(?:_Cutoff|_AlphaCutoff):[ \t]*([\d.]+)/m)?.[1] ?? .5)
  }
  return binding
}

export async function connectUnityMaterials(root, files) {
  const paths = new Set(files.map(file => file.path))
  const read = async path => await readBoundedText(root, path, 4 * 1024 ** 2) ?? ''
  const sources = files.filter(file => paths.has(file.path + '.meta') &&
    (file.ext === 'mat' || file.ext === 'fbx' || textureFormats.has(file.ext)))
  if (!sources.some(file => file.ext === 'mat') || !sources.some(file => file.ext === 'fbx')) return

  const entries = []
  for (let start = 0; start < sources.length; start += 64) {
    entries.push(...await Promise.all(sources.slice(start, start + 64).map(async file => {
      const meta = await read(file.path + '.meta')
      const guid = meta.match(/^guid:[ \t]*([\da-f]{32})\b/im)?.[1]?.toLowerCase()
      const content = file.ext === 'mat' ? await read(file.path) : null
      return { file, meta, guid, content }
    })))
  }
  const textures = new Map()
  const materialsByGuid = new Map()
  const materialsByName = new Map()
  const models = entries.filter(entry => entry.file.ext === 'fbx')
  const modelGuids = new Set(models.map(entry => entry.guid).filter(Boolean))
  const prefabByModel = new Map()
  for (const entry of entries) if (textureFormats.has(entry.file.ext)) add(textures, entry.guid, entry)
  for (const entry of entries.filter(entry => entry.file.ext === 'mat')) {
    entry.binding = textureBinding(entry, textures)
    if (!entry.binding) continue
    add(materialsByGuid, entry.guid, entry)
    const names = new Set([materialKey(entry.file.name.slice(0, -4))])
    for (const match of entry.content.matchAll(/^ +m_Name:[ \t]*([^\r\n]+)/gm)) names.add(materialKey(match[1]))
    for (const name of names) add(materialsByName, name, entry)
  }

  const prefabs = files.filter(file => file.ext === 'prefab')
  for (let start = 0; start < prefabs.length; start += 48) {
    const batch = await Promise.all(prefabs.slice(start, start + 48).map(async file => ({ file, meshes: prefabMeshes(await read(file.path)) })))
    for (const { file, meshes } of batch) {
      for (const mesh of meshes) if (modelGuids.has(mesh.model)) add(prefabByModel, mesh.model, { ...mesh, file })
    }
  }

  for (const { file, meta, guid } of models) {
    const bindings = new Map()
    for (const [, name] of meta.matchAll(/^ +21\d{5}:[ \t]*([^\r\n]+)/gm)) {
      const material = nearby(materialsByName.get(materialKey(name)) ?? [], file)
      if (material) bindings.set(materialKey(name), material.binding)
    }
    for (const match of meta.matchAll(/type:[ \t]*UnityEngine(?:\.[\w.]+)?:Material[ \t]*\r?\n(?:[ \t]+assembly:[^\r\n]*\r?\n)?[ \t]+name:[ \t]*([^\r\n]+)\r?\n[ \t]+second:[^\r\n]*\bguid:[ \t]*([\da-f]{32})\b/gi)) {
      const key = materialKey(match[1])
      const material = nearby(materialsByGuid.get(match[2].toLowerCase()) ?? [], file)
      if (material) bindings.set(key, { ...material.binding, remap: true })
    }
    if (bindings.size) file.materialTextures = Object.fromEntries(bindings)
    const matchingPrefabs = (prefabByModel.get(guid) ?? []).filter(entry => modelStem(entry.file) === modelStem(file))
    const prefab = nearby(matchingPrefabs, file)
    if (!prefab) continue
    const slots = Array.from(prefab.materials, key => {
      const material = nearby(materialsByGuid.get(key) ?? [], prefab.file)
      return material?.binding ?? null
    })
    if (!slots.some(Boolean)) continue
    const names = new Map([...meta.matchAll(/^ +(-?\d+):[ \t]*([^\r\n]+)/gm)].map(([, id, name]) => [id, unquote(name)]))
    file.prefabTextures = { mesh: names.get(prefab.meshId), slots }
  }
  return Object.fromEntries([...materialsByName].map(([name, entries]) => [name,
    entries.map(entry => ({ ...entry.binding, path: entry.file.path }))]))
}
