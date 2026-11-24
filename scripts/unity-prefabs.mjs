const guid = text => text?.match(/\bguid:[ \t]*([a-f\d]{32})\b/i)?.[1].toLowerCase()
const field = (text, key) => text.match(new RegExp(`^ +${key}:[ \\t]*([^\\r\\n]*)`, 'm'))?.[1]
const objectId = text => field(text, 'm_GameObject')?.match(/fileID:[ \t]*(-?\d+)/)?.[1]

export function prefabMeshes(source) {
  const filters = new Map()
  const renderers = []
  const meshes = []
  for (const document of source.split(/^--- !u!\d+[^\r\n]*\r?\n/gm)) {
    if (document.startsWith('MeshFilter:')) {
      filters.set(objectId(document), field(document, 'm_Mesh'))
    } else if (document.startsWith('MeshRenderer:') || document.startsWith('SkinnedMeshRenderer:')) {
      renderers.push(document)
    } else if (document.startsWith('PrefabInstance:')) {
      const model = guid(field(document, 'm_SourcePrefab'))
      if (!model) continue
      const overrides = new Map()
      for (const [, target, index, reference] of document.matchAll(/^ +- target:[ \t]*([^\r\n]*)\r?\n[ \t]+propertyPath: m_Materials\.Array\.data\[(\d+)\][ \t]*\r?\n[ \t]+value:[^\r\n]*\r?\n[ \t]+objectReference:[ \t]*([^\r\n]*)/gm)) {
        if (guid(target) !== model) continue
        if (!overrides.has(target)) overrides.set(target, [])
        overrides.get(target)[Number(index)] = guid(reference)
      }
      if (overrides.size === 1) meshes.push({ model, materials: [...overrides.values()][0] })
    }
  }
  for (const renderer of renderers) {
    const mesh = field(renderer, 'm_Mesh') ?? filters.get(objectId(renderer))
    const model = guid(mesh)
    const meshId = mesh?.match(/fileID:[ \t]*(-?\d+)/)?.[1]
    const list = renderer.match(/^ +m_Materials:[ \t]*\r?\n((?:[ \t]+- [^\r\n]+(?:\r?\n|$))*)/m)?.[1]
    if (!model || !list) continue
    meshes.push({ model, meshId, materials: [...list.matchAll(/^[ \t]+- ([^\r\n]+)/gm)].map(([, value]) => guid(value)) })
  }
  return meshes
}
