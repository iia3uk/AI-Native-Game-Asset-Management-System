import { json, post } from '../../shared/http.js'

export async function ensurePreview(file, folder) {
  if (!file.convertible || file.preview || !folder) return file
  const { preview } = await json(`/api/folder/${folder.id}/blend/${file.id}`, post({}))
  return { ...file, preview, previewFormat: 'glb' }
}
