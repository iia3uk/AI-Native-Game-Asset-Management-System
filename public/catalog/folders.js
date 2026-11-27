import { convertedImages } from '../preview/loaders/image-preview.js'
import { json, post } from '../shared/http.js'
import { readLocal, storageNamespace, storedValue } from './viewer-storage.js'

const foldersStorage = storageNamespace + '.folders.v1'
export const localTextures = file => file.kind === 'image' && (file.preview || convertedImages.has(file.ext))

export function createFolderCatalog(storage) {
  const localFolders = new Map()
  const packRequests = new Map()
  const userFolders = () => [...localFolders.values()].filter(folder => !folder.demo && !folder.indexed)

  function savedFolders() {
    try {
      const saved = JSON.parse(storedValue(storage, foldersStorage) ?? '[]')
      return Array.isArray(saved) ? saved.filter(item => typeof item?.root === 'string' && typeof item.id === 'string') : []
    } catch { return [] }
  }

  function saveFolders() {
    storage.setItem(foldersStorage, JSON.stringify(userFolders().map(({ id, root }) => ({ id, root }))))
  }

  function registerFolder(info, indexed = false) {
    if (indexed) {
      for (const [key, folder] of localFolders) if (folder.indexed) localFolders.delete(key)
      info = { ...info, key: 'indexed.' + info.key, indexed }
    }
    const name = info.root.split(/[\\/]/).filter(Boolean).at(-1) ?? info.root
    const previous = localFolders.get(info.key)
    if (previous && previous.id !== info.id) {
      for (const url of packRequests.keys()) if (url.startsWith(`/api/folder/${previous.id}/`)) packRequests.delete(url)
    }
    const resources = info.resources.map(file => ({ ...file, selectionId: info.key + '.' + file.id }))
    const folder = { ...info, name, images: resources.filter(localTextures), resources,
      marks: indexed ? {} : readLocal(storage, info, 'review'), maps: readLocal(storage, info, 'textures'),
    }
    localFolders.set(folder.key, folder)
    return folder
  }

  async function restoreFolders() {
    const entries = savedFolders()
    const results = await Promise.allSettled(entries.map(entry => json('/api/folder/' + encodeURIComponent(entry.id))
      .catch(() => json('/api/folder', post({ path: entry.root })))))
    for (const result of results) if (result.status === 'fulfilled') registerFolder(result.value)
  }

  async function fetchPack(pack) {
    const folder = pack.folderKey && localFolders.get(pack.folderKey)
    const url = folder ? `/api/folder/${folder.id}/group/${pack.groupId}` : '/api/packs/' + pack.id
    if (!packRequests.has(url)) {
      const request = json(url).catch(error => { packRequests.delete(url); throw error })
      packRequests.set(url, request)
    }
    return packRequests.get(url)
  }

  function modelResources(folder, files) {
    if (!folder) return files
    const otherImages = folder.demo || folder.indexed ? [] : userFolders().filter(other => other.key !== folder.key).flatMap(other => other.images)
    return otherImages.length ? folder.resources.concat(otherImages) : folder.resources
  }

  return { localFolders, userFolders, savedFolders, saveFolders, registerFolder, restoreFolders, fetchPack, modelResources }
}
