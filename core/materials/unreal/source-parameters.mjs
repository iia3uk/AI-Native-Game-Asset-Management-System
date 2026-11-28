const global = row => row.association === 'GlobalParameter' && row.index === -1
const key = value => value.normalize('NFC').toLowerCase()
const kinds = ['textures', 'scalars', 'vectors']

export function sourceMaterialParameters(asset, parsed, resolve) {
  const leaf = parsed.get(asset.id)
  const effective = { textures: [], scalars: [], vectors: [] }
  const used = new Map(kinds.map(kind => [kind, new Set()]))
  const seen = new Set()
  let parentStatus = leaf.parentStatus
  let normalInput
  for (let current = asset; current; ) {
    if (seen.size >= 16 || seen.has(current.id)) {
      parentStatus = 'invalid-lineage'
      break
    }
    seen.add(current.id)
    const material = parsed.get(current.id)
    if (!material) {
      parentStatus = 'missing'
      break
    }
    for (const kind of kinds) {
      const names = used.get(kind)
      const groups = Map.groupBy(material[kind].filter(global), row => key(row.name))
      for (const [name, rows] of groups) {
        if (names.has(name)) continue
        names.add(name)
        if (rows.length === 1) effective[kind].push({ ...rows[0], definedIn: current.sourcePath })
      }
    }
    if (current !== asset) parentStatus = material.parentStatus === 'base' ? 'resolved' : material.parentStatus
    if (material.parentStatus === 'base' && material.normalInput) {
      normalInput = { ...material.normalInput, definedIn: current.sourcePath }
    }
    if (!material.parent) break
    current = resolve(material.parent)
    if (!current) parentStatus = 'missing'
  }
  const streaming = Map.groupBy(leaf.streaming.filter(row => row.path), row => key(row.path))
  const corroborate = path => {
    const rows = streaming.get(key(path))
    return !!rows?.length && rows.every(row => row.uvChannel === 0)
  }
  if (!['resolved', 'base'].includes(parentStatus)) {
    for (const kind of kinds) effective[kind] = effective[kind].filter(row => row.definedIn === asset.sourcePath)
  }
  let normal = null
  if (normalInput) {
    const parameter = normalInput.parameter && key(normalInput.parameter)
    const override = parameter && used.get('textures').has(parameter)
    const path = override ? effective.textures.find(row => key(row.name) === parameter)?.path : normalInput.path
    if (path && corroborate(path)) normal = { ...normalInput, path }
  }
  return { ...effective, parentStatus, corroborate, normal }
}
