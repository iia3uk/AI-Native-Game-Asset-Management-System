import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { blenderModels, browserImages, browserModels, formatOrder, previewCandidates } from './formats.mjs'
import { connectUnityMaterials } from './unity-materials.mjs'
import { discoverAssets, fileInfo, folderPath, pathKey } from '../core/asset-files.mjs'

const runFile = promisify(execFile)
const exportScript = fileURLToPath(new URL('./export-blend.py', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24)
const sortByPath = (a, b) => a.path.localeCompare(b.path, 'ru', { numeric: true })
const encodePath = path => path.split('/').map(encodeURIComponent).join('/')
let cacheDirectory
const previewAbort = new AbortController()
let conversionTail = Promise.resolve()
let pendingConversions = 0

export async function browseFolder(path) {
  const root = await folderPath(path || homedir())
  const parent = dirname(root)
  const entries = await readdir(root, { withFileTypes: true })
  return { path: root, parent: parent === root ? null : parent, directories: entries
    .filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name, path: join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true })) }
}

export async function scanFolder(path) {
  const root = await folderPath(path)
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
      preview: browserModels.has(ext) || browserImages.has(ext) ? url : null,
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

async function blenderCommands() {
  if (process.env.ASSET_VIEWER_BLENDER) return [process.env.ASSET_VIEWER_BLENDER]
  if (process.platform === 'win32') {
    const install = process.env.ProgramFiles ?? 'C:/Program Files'
    const steam = process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)'
    const base = join(install, 'Blender Foundation')
    const versions = await readdir(base, { withFileTypes: true }).catch(() => [])
    return ['blender.exe', join(steam, 'Steam/steamapps/common/Blender/blender.exe'),
      ...versions.filter(item => item.isDirectory() && item.name.startsWith('Blender'))
        .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true })).map(item => join(base, item.name, 'blender.exe'))]
  }
  return process.platform === 'darwin' ? ['blender', '/Applications/Blender.app/Contents/MacOS/Blender'] : ['blender']
}

async function convertWithBlender(library, file) {
  previewAbort.signal.throwIfAborted()
  const inputFile = await fileInfo(library.root, file.path)
  if (!inputFile) throw new Error('Исходный файл недоступен.')
  if (inputFile.info.size > 512 * 1024 ** 2) throw new Error('Исходный файл превышает лимит преобразования 512 МиБ.')
  const { path: source } = inputFile
  cacheDirectory ??= mkdtemp(join(tmpdir(), 'asset-viewer-'))
  const target = join(await cacheDirectory, library.id + '-' + file.id + '.glb')
  const partial = target + '.partial.glb'
  const commands = await blenderCommands()
  for (const executable of commands) {
    try {
      const input = file.ext === 'blend' ? [source] : []
      await runFile(executable, ['--background', '--factory-startup', '--disable-autoexec', ...input, '--python-exit-code', '1',
        '--python', exportScript, '--', partial, library.root, ...(input.length ? [] : [source])],
      { timeout: 500_000, windowsHide: true, maxBuffer: 2 * 1024 ** 2, signal: previewAbort.signal })
      await rename(partial, target)
      return target
    } catch (error) {
      if (error.code === 'ENOENT') continue
      console.error('Blender preview:', file.name, error.stderr?.slice(-1200) || error.message)
      throw new Error('Blender не смог подготовить GLB-предпросмотр этого файла.')
    } finally {
      await rm(partial, { force: true })
    }
  }
  throw new Error('Для предпросмотра этого формата нужен Blender в PATH или путь в ASSET_VIEWER_BLENDER.')
}

export async function blenderPreview(library, file) {
  if (!library.previews.has(file.id)) {
    if (pendingConversions >= 8) throw new Error('Очередь Blender заполнена. Повторите позже.')
    pendingConversions++
    const operation = conversionTail.then(() => convertWithBlender(library, file)).catch(error => {
      library.previews.delete(file.id)
      throw error
    }).finally(() => {
      pendingConversions--
    })
    conversionTail = operation.catch(() => undefined)
    library.previews.set(file.id, operation)
  }
  return library.previews.get(file.id)
}

export async function closePreviews() {
  previewAbort.abort()
  await conversionTail
  if (cacheDirectory) await rm(await cacheDirectory, { recursive: true, force: true })
}
