import { ioStoreMaterialRevision } from '../../../engines/unreal/decoder/iostore-material-protocol.mjs'
import { publishCookedMaterials } from './publish.mjs'

export const zenMaterialMethod = 'cue4parse-iostore-zen-material'

const key = value => value.toLowerCase()

export async function publishIoStoreMaterials(entries, rows, { workspace, store, signal }) {
  const packages = new Map()
  for (const [index, { identity }] of rows.entries()) {
    const entry = entries[index]
    if (!identity || !entry.artifact?.path) continue
    const name = key(identity.package)
    packages.set(name, packages.has(name) ? null : { entry, identity })
  }
  const matchReference = reference => {
    if (!reference) return null
    const match = packages.get(key(reference.package))
    if (!match || (reference.hash ? reference.hash !== match.identity.hash :
      key(reference.object) !== key(match.identity.object))) return null
    return match.entry
  }
  const resolve = (reference, role) => {
    const target = matchReference(reference)
    return target?.exports?.some(product => product.role === role && product.path) ? target : null
  }
  const candidates = new Map(entries.filter((entry, index) => entry.artifact?.path && rows[index].material)
    .map(entry => [entry.path, entry]))
  const resolveParent = reference => {
    const target = matchReference(reference)
    return target && candidates.has(target.path) ? target : null
  }
  const targets = new Map()
  const results = new Map()
  const missing = []
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted()
    const { material, materialIssue } = rows[index]
    if (!entry.artifact?.path || (!material && !materialIssue)) continue
    if (materialIssue) {
      results.set(entry.path, { issue: materialIssue })
      continue
    }
    const add = (reference, target, type, parameter) => {
      if (target) targets.set(target.path, target)
      else if (reference) missing.push({ type, source: entry.id, path: reference.package, target: null, status: 'missing',
        reference, ...(parameter && { parameter }) })
      return target?.path ?? null
    }
    const parent = add(material.parent, resolveParent(material.parent), 'unreal-material-parent')
    const textures = material.textures.map(({ reference, value, status, ...info }) => {
      const path = add(reference, resolve(reference, 'texture'), 'unreal-material-texture', info.name)
      return { ...info, path, ...(reference && { reference }), ...(status && { status: path ? status : reference ? 'missing' : status }) }
    })
    const streaming = material.streaming.map(({ reference, ...data }) => ({
      ...data, ...(reference && { reference }),
      path: add(reference, resolve(reference, 'texture'), 'unreal-material-texture'),
    }))
    const numeric = ({ reference, status, value, ...info }) => value === null ? info : { ...info, value }
    results.set(entry.path, { material: { type: material.type, parent,
      parentStatus: material.type === 'Material' ? 'base' : parent ? 'reference' : material.parent ? 'missing' : 'unresolved',
      parentReference: material.parent, textures, streaming, scalars: material.scalars.map(numeric),
      vectors: material.vectors.map(numeric) } })
  }
  if (!results.size) return { materials: null, dependencies: missing, resolve }
  const { materials, dependencies } = await publishCookedMaterials(entries, { results, method: zenMaterialMethod,
    version: ioStoreMaterialRevision }, workspace, store, (_path, target) => targets.get(target), signal)
  return { materials, dependencies: [...dependencies, ...missing], resolve }
}
