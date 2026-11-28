import { open } from 'node:fs/promises'
import { checkedPath, sameFile } from '../../../files/asset-files.mjs'
import { materialClasses, readMaterialProperties } from '../source-material/properties.mjs'
import { cookedHeaderSize, cookedPackage } from './tables.mjs'

const maxMaterial = 8 * 1024 ** 2
const summaryLimit = 28 + 256 * 20

async function readRange(root, file, size, offset, signal) {
  const handle = await open(file.path, 'r')
  try {
    if (!sameFile(file.info, await handle.stat()) || !await checkedPath(root, file.path)) return null
    const bytes = Buffer.alloc(size)
    for (let read = 0; read < size;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, read, size - read, offset + read)
      if (!bytesRead) return null
      read += bytesRead
    }
    return sameFile(file.info, await handle.stat()) ? bytes : null
  } finally { await handle.close() }
}

export async function readCookedMaterial(root, headerFile, companionFile, signal) {
  const prefix = await readRange(root, headerFile, Math.min(headerFile.info.size, summaryLimit), 0, signal)
  const headerSize = prefix && cookedHeaderSize(prefix, headerFile.info.size)
  if (!headerSize) return null
  let table, object
  try {
    const header = await readRange(root, headerFile, headerSize, 0, signal)
    table = header && cookedPackage(header)
    object = table?.topLevel(materialClasses)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return null
  }
  if (!object) return null
  const size = object.end - object.start
  if (size > maxMaterial) return { issue: 'unreal-cooked-material-size' }
  const split = object.end > headerFile.info.size
  const file = split ? companionFile : headerFile
  const offset = split ? object.start - headerFile.info.size : object.start
  if (offset < 0) return { issue: 'unreal-cooked-material-layout' }
  if (!file) return { issue: 'unreal-cooked-material-export-missing' }
  if (offset > file.info.size - size) return { issue: 'unreal-cooked-material-layout' }
  const data = await readRange(root, file, size, offset, signal)
  if (!data) return { issue: 'unreal-cooked-material-read' }
  try {
    const material = readMaterialProperties(data, { ...table, nameAt: at => table.nameAt(at, data) },
      { ...object, start: 0, end: size }, { graph: false })
    return { material, split }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return { issue: 'unreal-cooked-material-layout' }
  }
}
