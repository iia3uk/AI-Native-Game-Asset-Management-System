import { createServer } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { browseFolder, scanFolder } from './core/library/local-folders.mjs'
import { blenderPreview, closePreviews } from './core/engines/blender/preview.mjs'
import { checkedPath, fileInfo, readBoundedText } from './core/files/asset-files.mjs'
import { dataPaths } from './core/config/data-paths.mjs'
import { generateFixtures } from './scripts/generate-fixtures.mjs'
import { indexRoutes } from './core/http/index-http.mjs'
import { sharedDirectoryAvailable } from './core/packages/storage/shared.mjs'

const project = fileURLToPath(new URL('.', import.meta.url))
try {
  process.loadEnvFile(resolve(project, '.env'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const { values } = parseArgs({ options: { folder: { type: 'string' } } })
const library = await realpath(resolve(project, process.env.FAB_ASSETS_ROOT || '../FAB_ASSETS'))
  .catch(error => { if (error.code !== 'ENOENT') throw error; return null })
const publicPath = resolve(project, 'public')
const three = resolve(project, 'node_modules/three')
const rhino = resolve(project, 'node_modules/rhino3dm')
const reviewPath = 'Viewer/selections.json'
const port = Number(process.env.ASSET_VIEWER_PORT || 8177)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ASSET_VIEWER_PORT должен быть от 0 до 65535.')
const desktopToken = process.env.ASSET_VIEWER_DESKTOP_TOKEN
const metadataLimit = 64 * 1024 ** 2
const identifier = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const fileIdentifier = /^[a-f\d]{24}$/
const statuses = new Set(['candidate', 'later', 'excluded', ''])
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
  '.apng': 'image/apng', '.jpe': 'image/jpeg', '.jfif': 'image/jpeg', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg',
}
let reviewWrites = Promise.resolve()
let viewFiles
let viewFilesUpdated
const folders = new Map()
const indexedFolders = new Map()
let demoRequest
const paths = dataPaths()
const indexed = indexRoutes({ database: paths.database, thumbnailDirectory: paths.thumbnails,
  desktop: Boolean(desktopToken),
  importDirectory: paths.imports, ignoredWatchPaths: [paths.cache, paths.backups, paths.imports], json, body, allowsWrite,
  exportProtectedRoots: [paths.data, paths.cache, paths.config, library],
  openFolder: openIndexedFolder, invalidateFolder: invalidateIndexedFolder })

async function safeFile(base, subpath) {
  const file = await fileInfo(base, subpath)
  return file && { ...file, base }
}

async function fabJson(path, missing = null) {
  if (!library) return missing
  const content = await readBoundedText(library, path, metadataLimit)
  return content === null ? missing : JSON.parse(content)
}

async function fileEntryExists(path) {
  return lstat(path).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

async function writeReview(selection) {
  const directory = await checkedPath(library, 'Viewer')
  if (!directory) throw new Error('Каталог Fab Viewer недоступен.')
  const temporary = resolve(directory, 'selections-' + randomUUID() + '.tmp')
  try {
    await writeFile(temporary, JSON.stringify(selection, null, 2) + '\n', { flag: 'wx' })
    if (!await checkedPath(library, directory)) throw new Error('Каталог Fab Viewer перемещён.')
    await rename(temporary, resolve(library, reviewPath))
  } finally {
    await rm(temporary, { force: true })
  }
}

function json(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function loadReview() {
  const selection = await fabJson(reviewPath)
  if (selection?.entries && typeof selection.entries === 'object' && !Array.isArray(selection.entries)) return selection
  // A blocked or unreadable existing review must never be overwritten by an empty selection.
  if (selection !== null || (library && await fileEntryExists(resolve(library, reviewPath)))) {
    throw new Error('Невозможно прочитать существующие отметки Fab.')
  }
  return { version: 1, entries: {} }
}

function allowsWrite(request) {
  return request.headers.origin === 'http://' + request.headers.host &&
    request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

function allowsDesktopRequest(request) {
  if (!desktopToken) return true
  const token = request.headers['x-asset-viewer-desktop']
  return typeof token === 'string' && token.length === desktopToken.length &&
    Buffer.byteLength(token) === Buffer.byteLength(desktopToken) &&
    timingSafeEqual(Buffer.from(token), Buffer.from(desktopToken))
}

async function body(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8192) throw new Error('Payload too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function changeReview(request, response) {
  if (!allowsWrite(request)) {
    json(response, 403, { error: 'Недопустимый источник запроса' })
    return
  }
  const change = await body(request).catch(() => null)
  if (!change || !identifier.test(change.pack ?? '') || !fileIdentifier.test(change.file ?? '') ||
      !statuses.has(change.status) || typeof change.note !== 'string' || change.note.length > 1200) {
    json(response, 400, { error: 'Некорректная отметка' })
    return
  }
  const pack = await fabJson('Viewer/packs/' + change.pack + '.json')
  const file = Array.isArray(pack?.files) && pack.files.find(item => item.id === change.file)
  if (!file) {
    json(response, 404, { error: 'Файл отсутствует в каталоге' })
    return
  }
  const operation = reviewWrites.then(async () => {
    const selection = await loadReview()
    const key = change.pack + ':' + change.file
    const record = { fabId: pack.id, asset: pack.title, file: file.path, status: change.status,
      note: change.note.trim(), updatedAt: new Date().toISOString() }
    if (!record.status && !record.note) delete selection.entries[key]
    else selection.entries[key] = record
    await writeReview(selection)
    return selection
  })
  reviewWrites = operation.catch(() => undefined)
  json(response, 200, await operation)
}

async function isAsset(path) {
  if (!library || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) return false
  if (/^(?:Unpacked|Previews)\/[a-f\d-]{36}\//i.test(path)) {
    return !path.split('/').some(part => part.endsWith('.partial') || part === '.extracted.json' || part === 'issues.json')
  }
  const catalog = await fileInfo(library, 'catalog.json')
  if (!catalog) return false
  const modified = catalog.info.mtimeMs
  if (viewFilesUpdated !== modified) {
    const document = await fabJson('catalog.json')
    viewFiles = new Set(document?.assets.flatMap(asset => asset.files.filter(file => !file.archive).map(file => file.path)))
    viewFilesUpdated = modified
  }
  return viewFiles.has(path)
}

async function openFolder(path, options) {
  const folder = await scanFolder(path, options)
  folders.set(folder.id, folder)
  return folder
}

function invalidateIndexedFolder(id) {
  const entry = indexedFolders.get(id)
  indexedFolders.delete(id)
  void entry?.folder.then(folder => folders.delete(folder.id), () => undefined)
}

async function openIndexedFolder(asset, scope) {
  const current = indexedFolders.get(asset.libraryId)
  if (current?.generation === asset.generation) {
    const folder = await current.folder
    if (folder.files.has(asset.path)) return folder
  }
  invalidateIndexedFolder(asset.libraryId)
  const next = { generation: asset.generation, folder: openFolder(asset.root, { canonical: true }).then(folder => {
    if (scope) folder.storageScope = scope
    return folder
  }) }
  indexedFolders.set(asset.libraryId, next)
  try {
    return await next.folder
  } catch (error) {
    if (indexedFolders.get(asset.libraryId) === next) indexedFolders.delete(asset.libraryId)
    throw error
  }
}

function availableFolder(id) {
  const folder = folders.get(id)
  if (!folder?.storageScope || sharedDirectoryAvailable(folder.storageScope)) return folder
  return null
}

async function openDemo() {
  const root = paths.demo
  await generateFixtures(root)
  const folder = await openFolder(root)
  folder.info.demo = true
  return folder.info
}

async function handleFolder(request, response, path) {
  if (request.method === 'POST' && !allowsWrite(request)) {
    return json(response, 403, { error: 'Недопустимый источник запроса' })
  }
  if (request.method === 'POST' && ['/api/folder', '/api/folder/browse'].includes(path)) {
    const input = await body(request).catch(() => null)
    if (!input || typeof input.path !== 'string') return json(response, 400, { error: 'Укажите путь к папке' })
    try {
      const data = path.endsWith('/browse') ? await browseFolder(input.path) : (await openFolder(input.path)).info
      return json(response, 200, data)
    } catch (error) {
      const message = ['ENOENT', 'EPERM', 'EACCES'].includes(error.code) ? 'Папка не найдена или недоступна.' : error.message
      return json(response, 400, { error: message })
    }
  }
  const [, , , id, route, fileId] = path.split('/')
  const folder = availableFolder(id)
  if (!folder) return json(response, 404, { error: 'Папка закрыта. Выберите её снова.' })
  if (request.method === 'GET' && !route) return json(response, 200, folder.info)
  if (request.method === 'GET' && route === 'group') {
    const pack = folder.packs.get(fileId)
    if (pack) return json(response, 200, { ...pack.summary, files: pack.files, unityMaterials: folder.unityMaterials })
  }
  if (request.method === 'POST' && route === 'blend') {
    const file = folder.fileIds.get(fileId)
    if (file?.convertible) {
      try {
        await blenderPreview(folder, file)
        return json(response, 200, { preview: `/local-previews/${id}/${file.id}` })
      } catch (error) {
        return json(response, 422, { error: error.message })
      }
    }
  }
  return json(response, 404, { error: 'Файл или папка отсутствует' })
}

async function sendFile(request, response, file, asset = false) {
  if (!file) {
    json(response, 404, { error: 'Файл отсутствует' })
    return
  }
  const handle = await open(file.path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || !await checkedPath(file.base, file.path)) return json(response, 404, { error: 'Файл отсутствует' })
    const { size, mtime } = info
    const extension = extname(file.path).toLowerCase()
    const safeAssetType = asset && ['.html', '.css', '.js', '.mjs', '.wasm'].includes(extension)
    const headers = { 'Content-Type': safeAssetType ? 'application/octet-stream' : (mime[extension] ?? 'application/octet-stream'),
      'Cache-Control': asset ? 'private, max-age=120' : 'no-cache', 'Last-Modified': mtime.toUTCString(), 'Accept-Ranges': 'bytes' }
    if (asset && extension === '.svg') {
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '')
    let start = 0
    let end = size - 1
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      if (range[1] && range[2]) end = Math.min(end, Number(range[2]))
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
        response.writeHead(416, { 'Content-Range': 'bytes */' + size }).end()
        return
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    }
    headers['Content-Length'] = Math.max(0, end - start + 1)
    response.writeHead(headers['Content-Range'] ? 206 : 200, headers)
    if (request.method === 'HEAD' || !size) response.end()
    else await pipeline(handle.createReadStream({ start, end }), response).catch(error => {
      if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
    })
  } finally {
    await handle.close()
  }
}

const startupPath = values.folder || process.env.ASSET_VIEWER_FOLDER
const startupFolder = startupPath ? await openFolder(resolve(startupPath)) : null
const html = await readFile(resolve(publicPath, 'index.html'), 'utf8')
const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? ''
const importMapHash = createHash('sha256').update(importMap).digest('base64')
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'sha256-${importMapHash}' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`)
  try {
    const activePort = server.address()?.port
    const host = request.headers.host
    if (![`127.0.0.1:${activePort}`, `localhost:${activePort}`].includes(host) ||
        !allowsDesktopRequest(request) ||
        (request.headers.origin !== undefined && request.headers.origin !== 'http://' + host) ||
        request.headers['sec-fetch-site'] === 'cross-site' && request.headers['sec-fetch-mode'] !== 'navigate') {
      json(response, 403, { error: 'Доступ только с локального компьютера' })
      return
    }
    let path
    try {
      path = decodeURIComponent(new URL(request.url, 'http://' + host).pathname)
    } catch {
      json(response, 400, { error: 'Некорректный путь запроса' })
      return
    }
    if (request.method === 'POST' && path === '/api/demo') {
      if (!allowsWrite(request)) return json(response, 403, { error: 'Недопустимый источник запроса' })
      demoRequest ??= openDemo().catch(error => { demoRequest = undefined; throw error })
      return json(response, 200, await demoRequest)
    }
    if (path.startsWith('/api/index/')) {
      await indexed.handle(request, response, path)
      return
    }
    if (request.method === 'POST' && path === '/api/review') {
      await changeReview(request, response)
      return
    }
    if (request.method === 'GET' && path === '/api/folder') {
      json(response, 200, { startup: startupFolder?.id ?? null })
      return
    }
    if (path === '/api/folder' || path.startsWith('/api/folder/')) {
      await handleFolder(request, response, path)
      return
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      json(response, 405, { error: 'Метод недоступен' })
      return
    }
    if (path === '/api/review') {
      json(response, 200, await loadReview())
    } else if (path === '/api/library') {
      const index = library && await safeFile(library, 'Viewer/index.json')
      if (index) await sendFile(request, response, index)
      else json(response, 200, { packs: [] })
    } else if (library && path.startsWith('/api/packs/') && identifier.test(path.slice(11))) {
      await sendFile(request, response, await safeFile(library, 'Viewer/packs/' + path.slice(11) + '.json'))
    } else if (path.startsWith('/files/') && await isAsset(path.slice(7))) {
      await sendFile(request, response, await safeFile(library, path.slice(7)), true)
    } else if (path.startsWith('/vendor/three/')) {
      await sendFile(request, response, await safeFile(three, path.slice(14)))
    } else if (path === '/vendor/rhino3dm/worker.js') {
      const { Rhino3dmWorker } = await import('three/addons/loaders/3DMLoader.js')
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self'",
      }).end(request.method === 'HEAD' ? undefined :
        `importScripts('/vendor/rhino3dm/rhino3dm.js');\n(${Rhino3dmWorker.toString()})();\n`)
    } else if (path === '/vendor/rhino3dm/rhino3dm.js' || path === '/vendor/rhino3dm/rhino3dm.wasm') {
      await sendFile(request, response, await safeFile(rhino, path.slice(17)))
    } else if (path.startsWith('/local-files/')) {
      const [, , id, ...pieces] = path.split('/')
      const folder = availableFolder(id)
      const file = folder?.files.get(pieces.join('/'))
      await sendFile(request, response, file && await safeFile(folder.root, file.path), true)
    } else if (path.startsWith('/local-previews/')) {
      const [, , id, file] = path.split('/')
      const preview = await availableFolder(id)?.previews.get(file)?.catch(() => null)
      await sendFile(request, response, preview && await safeFile(dirname(preview), preview), true)
    } else {
      await sendFile(request, response, await safeFile(publicPath, path === '/' ? 'index.html' : path.slice(1)))
    }
  } catch (error) {
    if (response.headersSent) response.destroy()
    else json(response, 500, { error: 'Ошибка чтения локальной библиотеки' })
    console.error(error.message)
  }
})
server.on('listening', () => {
  indexed.startExisting()
  const { port } = server.address()
  console.log(`Asset Viewer · http://127.0.0.1:${port}`)
  process.parentPort?.postMessage({ type: 'ready', port })
})
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port && process.env.ASSET_VIEWER_PORT_FALLBACK === '1') {
    server.listen(0, '127.0.0.1')
  } else {
    console.error(error.message)
    process.exit(1)
  }
})
server.listen(port, '127.0.0.1')

let stopping
function shutdown() {
  if (stopping) return stopping
  indexed.abort()
  const disconnected = new Promise(resolve => server.close(resolve))
  stopping = Promise.allSettled([closePreviews(), disconnected.then(indexed.close)])
  return stopping
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutdown())
process.parentPort?.on('message', ({ data }) => {
  if (data?.type === 'shutdown') void shutdown().then(() => process.exit())
})
