import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { blenderModels, browserImages, browserModels, formatOrder, previewCandidates } from '../files/formats.mjs'
import { connectUnityMaterials } from '../materials/unity/folder-bindings.mjs'
import { discoverAssets, folderPath, pathKey } from '../files/asset-files.mjs'

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24)
const sortByPath = (a, b) => a.path.localeCompare(b.path, 'ru', { numeric: true })
const encodePath = path => path.split('/').map(encodeURIComponent).join('/')

export async function browseFolder(path) {
  const root = await folderPath(path || homedir())
  const parent = dirname(root)
  const entries = await readdir(root, { withFileTypes: true })
  return { path: root, parent: parent === root ? null : parent, directories: entries
    .filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name, path: join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true })) }
}

export async function scanFolder(path, { canonical = false } = {}) {
  const root = canonical ? path : await folderPath(path)
  const id = randomUUID()
  const key = hash(pathKey(root))
  const groups = new Map()
  const files = new Map()
  const fileIds = new Map()
  for await (const { path, ext, kind, info: { size } } of discoverAssets(root)) {
    const filename = basename(path)
    const url = '/local-files/' + id + '/' + encodePath(path)
    const file = {
      id: hash(path), name: filename, path, displayPath: path, ext, kind, size, url,
      preview: browserModels.has(ext) || browserImages.has(ext) || ext === 'wav' ? url : null,
    }
    if (blenderModels.has(ext)) file.convertible = true
    files.set(path, file)
    fileIds.set(file.id, file)
    const folder = path.includes('/') ? path.split('/')[0] : ''
    if (!groups.has(folder)) groups.set(folder, [])
    groups.get(folder).push(file)
  }

  const unityMaterials = await connectUnityMaterials(root, [...files.values()])
  const packs = new Map()
  for (const [folder, contents] of groups) {
    const models = contents.filter(file => file.kind === 'model').sort((a, b) =>
      Number(Boolean(b.preview || b.convertible)) - Number(Boolean(a.preview || a.convertible)) ||
      formatOrder.indexOf(a.ext) - formatOrder.indexOf(b.ext) || sortByPath(a, b))
    const images = contents.filter(file => file.kind === 'image').sort(sortByPath)
    const others = contents.filter(file => file.kind === 'other').sort(sortByPath)
    const packId = hash(folder)
    const summary = {
      id: packId, title: folder || basename(root) || root, author: '', category: 'Local', formats: [...new Set(models.map(file => file.ext))],
      localPath: folder || '.', models: models.length, textures: images.length,
      directModels: models.filter(file => file.preview).length,
      modelIds: models.map(file => file.id),
      previewFiles: previewCandidates(models),
      files: contents.length, defaultFile: models[0]?.id ?? images.find(file => file.preview)?.id ?? images[0]?.id ?? others[0]?.id,
      previewImage: images.find(file => file.preview && file.size < 1024 ** 2)?.preview ?? null,
    }
    packs.set(packId, { summary, files: [...models, ...images, ...others] })
  }
  const summaries = [...packs.values()].map(item => item.summary).sort((a, b) =>
    Number(Boolean(b.directModels)) - Number(Boolean(a.directModels)) ||
    Number(Boolean(b.models)) - Number(Boolean(a.models)) || a.title.localeCompare(b.title, 'ru', { numeric: true }))
  return { id, key, root, files, fileIds, packs, unityMaterials, previews: new Map(),
    info: { id, key, root, packs: summaries, files: files.size, resources: [...files.values()] } }
}
