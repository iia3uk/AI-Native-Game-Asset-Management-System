import { readCookedRange } from '../cooked-package/file.mjs'
import { taggedProperties } from '../editor-package/properties.mjs'
import { requireLayout } from '../package-tables.mjs'
import { ownedBodySetup, readBodySetup } from './body.mjs'

export const cookedCollisionRevision = 1
const meshPrefixLimit = 512 * 1024
const bodyLimit = 2 * 1024 ** 2

async function exportBytes(root, { header, files }, object, bytes, signal) {
  const split = object.end > header.info.size
  const file = split ? files.get('uexp') : header
  const offset = split ? object.start - header.info.size : object.start
  if (!file) return { issue: 'unreal-cooked-collision-export-missing' }
  if (offset < 0 || object.end - object.start > file.info.size - offset) {
    return { issue: 'unreal-cooked-collision-layout' }
  }
  const data = await readCookedRange(root, file, bytes, offset, signal)
  return data ? { data } : { issue: 'unreal-cooked-collision-read' }
}

function meshBodyIndex(bytes, nameAt) {
  const { end } = taggedProperties(bytes, 0, bytes.length, nameAt)
  requireLayout(end + 4 <= bytes.length)
  const guid = bytes.readInt32LE(end)
  const flags = end + (guid ? 20 : 4)
  requireLayout((guid === 0 || guid === 1) && flags + 10 <= bytes.length &&
    (bytes[flags] & 1) === 1 && bytes.readInt32LE(flags + 2) === 1)
  return bytes.readInt32LE(flags + 6)
}

export async function readCookedCollision(root, input, table, mesh, signal) {
  const prefix = await exportBytes(root, input, mesh, Math.min(mesh.end - mesh.start, meshPrefixLimit), signal)
  if (!prefix.data) return prefix
  try {
    const index = meshBodyIndex(prefix.data, at => table.nameAt(at, prefix.data))
    if (!index) return null
    const body = ownedBodySetup({ ...mesh, exported: table.exported }, index)
    const size = body.end - body.start
    if (size > bodyLimit) return { issue: 'unreal-cooked-collision-size' }
    const payload = await exportBytes(root, input, body, size, signal)
    if (!payload.data) return payload
    const collision = readBodySetup(payload.data, { ...body, start: 0, end: size },
      at => table.nameAt(at, payload.data), { deriveHull: true })
    return collision && { collision }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return { issue: 'unreal-cooked-collision-layout' }
  }
}
