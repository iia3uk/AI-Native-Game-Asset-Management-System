import { posix } from 'node:path'
import { readBoundedText } from '../../files/asset-files.mjs'
import { viewerMaterialSlots } from '../../materials/unreal/viewer-properties.mjs'
import { catalogJson } from './documents.mjs'

const nameKey = file => posix.basename(file.name, '.' + file.ext).normalize('NFC').toLowerCase()

export async function attachViewerMaterials(root, prefix, files) {
  const viewer = posix.join(prefix, 'UEViewer') + '/'
  if (!files.some(file => file.ext === 'gltf' && file.path.startsWith(viewer))) return
  const dumps = Map.groupBy(files.filter(file => file.ext === 'mat' && file.path.startsWith(viewer)), nameKey)
  if (!dumps.size || dumps.size > 1024) return
  const images = Map.groupBy(files.filter(file => file.kind === 'image' && file.preview && file.path.startsWith(prefix ? prefix + '/' : '')), nameKey)
  const slots = Object.create(null)
  for (const [name, [dump, duplicate]] of dumps) {
    if (duplicate) continue
    const content = await readBoundedText(root, dump.path, 16 * 1024)
    if (!content) continue
    const { Diffuse, Normal } = viewerMaterialSlots(content)
    const matches = value => images.get(value?.normalize('NFC').toLowerCase()) ?? []
    const [diffuse, ambiguous] = matches(Diffuse)
    if (!diffuse || ambiguous) continue
    const [normal, duplicateNormal] = matches(Normal)
    slots[name] = { url: diffuse.url, textureIds: [diffuse.id, ...(normal && !duplicateNormal ? [normal.id] : [])] }
  }
  for (const file of files) {
    if (file.ext !== 'gltf' || !file.path.startsWith(viewer)) continue
    const document = await catalogJson(root, file.path, 1024 ** 2)
    if (!Array.isArray(document?.materials) || document.materials.length > 128) continue
    const bindings = Object.create(null)
    const related = new Set()
    for (const material of document.materials) {
      if (typeof material?.name !== 'string') continue
      const key = material.name.trim().normalize('NFC').toLowerCase()
      const slot = slots[key]
      if (!slot) continue
      bindings[key] = { url: slot.url }
      for (const id of slot.textureIds) related.add(id)
    }
    if (related.size) {
      file.materialTextures = bindings
      file.relatedTextures = [...related]
    }
  }
}
