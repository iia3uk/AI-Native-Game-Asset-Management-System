import { materialClasses, readMaterialProperties } from '../source-material/properties.mjs'
import { readCookedTables, readCookedRange } from './file.mjs'

const maxMaterial = 8 * 1024 ** 2

export async function readCookedMaterial(root, headerFile, companionFile, signal) {
  let table, object
  try {
    table = await readCookedTables(root, headerFile, signal)
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
  const data = await readCookedRange(root, file, size, offset, signal)
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
