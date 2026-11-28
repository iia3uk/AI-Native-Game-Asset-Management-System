import { posix } from 'node:path'
import { analyzeAsset } from '../../analysis/asset-analysis.mjs'
import { fileInfo, pathKey } from '../../files/asset-files.mjs'

const linkedFormats = new Set(['obj', 'mtl', 'gltf', 'glb', 'vrm'])
const unrealCompanions = /\.(?:(?:m\.)?(?:uexp|ubulk|uptnl)|uasset|umap)$/i
const unrealKey = path => path?.normalize('NFC').toLowerCase().replace(unrealCompanions, '')
const objectKey = ref => JSON.stringify([ref?.member, ref?.pathId])

function relationships(assets, document, archive) {
  const links = new Map()
  const add = (source, target, info) => {
    if (!source) return
    if (!links.has(source)) links.set(source, [])
    links.get(source).push({ target, info })
  }
  if (archive) {
    const groups = Map.groupBy(assets.filter(row => row.artifact && unrealCompanions.test(row.path)),
      row => JSON.stringify([unrealKey(row.path), row.chunkId?.slice(0, 22)]))
    const include = (source, target) => add(source, target,
      { type: 'unreal-package-companion', source: source.path, path: target.path, status: 'resolved' })
    for (const [first, ...companions] of groups.values()) {
      for (const companion of companions) {
        include(first, companion)
        include(companion, first)
      }
    }
    const byId = new Map(assets.map(row => [row.id, row]))
    for (const info of Array.isArray(document.entries) ? document.entries : []) {
      if (typeof info?.source !== 'string') continue
      const target = info.status === 'resolved' ? byId.get(info.target) : null
      add(byId.get(info.source), target, info)
    }
  } else if (Array.isArray(document.dependencies)) {
    const byGuid = new Map(assets.map(row => [row.id, row]))
    for (const info of document.dependencies) {
      const target = ['resolved', 'guid-resolved'].includes(info.status) ? byGuid.get(info.target) : null
      add(byGuid.get(info.source), target, info)
    }
  } else if (Array.isArray(document.entries)) {
    const byObject = new Map(assets.map(row => [objectKey(row), row]))
    for (const info of document.entries) {
      const target = info.status === undefined || info.status === 'resolved' ? byObject.get(objectKey(info.to)) : null
      const status = info.status && info.status !== 'resolved' ? info.status : target?.artifact ? 'resolved' : 'missing'
      add(byObject.get(objectKey(info.from)), target?.artifact ? target : null, { ...info, status })
    }
  }
  return links
}

async function linkedFiles(directory, row, byOutput, signal) {
  if (typeof row.output !== 'string') return []
  const ext = posix.extname(row.output).slice(1).toLowerCase()
  if (!linkedFormats.has(ext)) return []
  const file = await fileInfo(directory, row.output)
  if (!file) return []
  const { dependencies, dependenciesTruncated, status } = await analyzeAsset(directory,
    { absolute: file.path, path: row.output, info: file.info, ext }, signal)
  const links = dependencies.filter(ref => ref.location !== 'embedded').map(ref => {
    const target = ref.location === 'local' ? byOutput.get(pathKey(ref.path)) : null
    return { target, info: { type: ref.role, source: row.output, path: ref.path,
      status: target ? 'resolved' : ref.location === 'local' ? 'missing' : ref.location } }
  })
  if (status !== 'analyzed' || dependenciesTruncated) {
    links.push({ info: { type: 'model-dependency-analysis', source: row.output, status: 'incomplete' } })
  }
  return links
}

export async function selectPackageAssets({ assets, directory, archive }, dependencies, selected, signal) {
  const links = relationships(assets, dependencies, archive)
  const byOutput = new Map(assets.filter(row => typeof row.output === 'string').map(row => [pathKey(row.output), row]))
  const seen = new Set([selected])
  const records = []
  // Iteration also visits assets discovered through nested references, with cycle detection.
  for (const row of seen) {
    signal.throwIfAborted()
    const linked = await linkedFiles(directory, row, byOutput, signal)
    for (const { target, info } of [...(links.get(row) ?? []), ...linked]) {
      records.push(info)
      if (target) seen.add(target)
    }
  }
  return { selected, assets: [...seen], records,
    unresolved: records.filter(info => !['resolved', 'guid-resolved', 'builtin'].includes(info.status)).length }
}
