import { readCookedRange } from '../cooked-package/file.mjs'
import { taggedProperties } from '../editor-package/properties.mjs'
import { importedPackageObject } from '../editor-package/references.mjs'
import { editorPackage } from '../editor-package/tables.mjs'
import { requireLayout } from '../package-tables.mjs'
import { readReferenceSkeleton } from './reference.mjs'

export const ue4SkeletonRevision = 2
export const ue4EditorSkeletonVersions = new Set([514, 518, 522])
const classes = new Set(['Skeleton', 'SkeletalMesh'])
const skeletonClass = new Set(['Skeleton'])
const materialClasses = new Set(['Material', 'MaterialInstance', 'MaterialInstanceConstant'])
const prefixLimit = 2 * 1024 ** 2
const versionIds = new Map([
  ['cffc743f43b04480939114df171d2073', 'framework'],
  ['e4b068edf49442e9a231da0b2e46bb41', 'editor'],
  ['375ec13c06e448fbb50084f0262a717e', 'core'],
  ['12f88b9f88754afca67cd90c383abd29', 'rendering'],
  ['601d1886ac644f84aa16d3de0deac7d6', 'fortnite'],
  ['d78a4a00e8584697baa819b5487d46b4', 'skeletal'],
  ['5579f886933a4c1f83ba087b6361b92f', 'tangent'],
])

export function ue4SkeletonVersions(bytes) {
  const count = bytes.readInt32LE(20)
  requireLayout(count >= 0 && count <= 256 && 24 + count * 20 <= bytes.length)
  const versions = {}
  for (let at = 24; at < 24 + count * 20; at += 20) {
    const id = [0, 4, 8, 12].map(offset => bytes.readUInt32LE(at + offset).toString(16).padStart(8, '0')).join('')
    const key = versionIds.get(id)
    if (!key) continue
    const value = bytes.readInt32LE(at + 16)
    requireLayout(!Object.hasOwn(versions, key) && value >= 0)
    versions[key] = value
  }
  return versions
}

function meshMaterials(bytes, at, nameAt, editor, versions, imported) {
  requireLayout(at + 34 <= bytes.length && Boolean(bytes[at] & 1) !== editor)
  at += 30 // Strip flags and the single-precision imported bounds.
  const count = bytes.readInt32LE(at)
  at += 4
  requireLayout(count >= 0 && count <= 256)
  const materials = []
  if (count) requireLayout(versions.editor >= 8 && versions.fortnite < 196)
  for (let index = 0; index < count; index++) {
    requireLayout(at + 12 <= bytes.length)
    const path = imported && importedPackageObject(imported, bytes.readInt32LE(at), materialClasses)
    const name = nameAt(at + 4)
    at += 12 // Material reference and slot FName.
    let importedName = editor
    if (versions.core >= 3) {
      requireLayout(at + 4 <= bytes.length && bytes.readUInt32LE(at) <= 1)
      importedName = bytes.readUInt32LE(at) === 1
      at += 4
    }
    let original
    if (importedName) {
      original = nameAt(at)
      at += 8
    }
    if (versions.rendering >= 10) {
      requireLayout(at + 24 <= bytes.length && bytes.readUInt32LE(at) <= 1 && bytes.readUInt32LE(at + 4) <= 1)
      for (let offset = 8; offset < 24; offset += 4) requireLayout(Number.isFinite(bytes.readFloatLE(at + offset)))
      at += 24
    }
    materials.push({ name, original, path })
  }
  return { end: at, materials }
}

function decode(bytes, table, object, editor, versions, detailed = false) {
  const nameAt = at => table.nameAt(at, bytes)
  const { end, properties } = taggedProperties(bytes, 0, bytes.length, nameAt, table.layout.fileVersionUE4)
  requireLayout(end + 4 <= bytes.length && bytes.readUInt32LE(end) <= 1)
  let at = end + (bytes.readUInt32LE(end) ? 20 : 4)
  let skeletonPackage
  let materials
  if (object.type === 'SkeletalMesh') {
    const mesh = meshMaterials(bytes, at, nameAt, editor, versions, detailed && table.imported)
    at = mesh.end
    materials = mesh.materials
    const link = properties.get('Skeleton')
    if (link?.type === 'ObjectProperty' && link.size === 4) {
      skeletonPackage = importedPackageObject(table.imported, bytes.readInt32LE(link.start), skeletonClass)
    }
  }
  const reference = readReferenceSkeleton(bytes, at, nameAt, editor)
  // The legacy editor layout stores the GUID after the retarget-source map.
  const skeletonGuid = object.type === 'Skeleton' && editor && table.layout.fileVersionUE4 === 514 &&
    versions.framework === 30 && reference.end + 20 <= bytes.length && bytes.readInt32LE(reference.end) === 0 ?
    bytes.toString('hex', reference.end + 4, reference.end + 20) : null
  const rig = { object: object.name, objectClass: object.type, serialization: table.layout.fileVersionUE4,
    ...(skeletonPackage && { skeletonPackage }), ...(skeletonGuid && { skeletonGuid }), bones: reference.bones }
  return detailed ? { rig, materials, properties, end: reference.end } : rig
}

const editorVersions = bytes => ({ core: 0, rendering: 0, fortnite: 0, ...ue4SkeletonVersions(bytes) })

export function readEditorMeshReference(bytes, table, object) {
  const payload = bytes.subarray(object.start, object.end)
  return { payload, ...decode(payload, table, object, true, editorVersions(bytes), true) }
}

function inspect(decodeSkeleton) {
  try {
    return decodeSkeleton()
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return { issue: 'unreal-ue4-skeleton-layout' }
  }
}

export function extractEditorSkeleton(bytes, version, tables) {
  let table, object
  try {
    table = tables === undefined ? editorPackage(bytes, version) : tables
    object = table?.topLevel(classes)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return null
  }
  if (!object) return null
  return inspect(() => ({ rig: decode(bytes.subarray(object.start, Math.min(object.end, object.start + prefixLimit)), table,
    object, true, editorVersions(bytes)) }))
}

export async function extractCookedSkeleton(root, { header, files }, table, signal) {
  const match = inspect(() => table.topLevel(classes))
  if (!match || match.issue) return match
  const size = match.end - match.start
  const split = match.end > header.info.size
  const file = split ? files.get('uexp') : header
  const offset = split ? match.start - header.info.size : match.start
  if (!file) return { issue: 'unreal-ue4-skeleton-export-missing' }
  if (offset < 0 || size > file.info.size - offset) return { issue: 'unreal-ue4-skeleton-layout' }
  const bytes = await readCookedRange(root, file, Math.min(size, prefixLimit), offset, signal)
  if (!bytes) return { issue: 'unreal-ue4-skeleton-read' }
  return inspect(() => ({ rig: decode(bytes, table, match, false,
    { editor: 40, core: 4, rendering: 45, fortnite: 0, ...ue4SkeletonVersions(table.summaryBytes) }),
    ...(split && { sidecar: file }) }))
}
