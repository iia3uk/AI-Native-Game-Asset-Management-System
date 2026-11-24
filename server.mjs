import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { blenderPreview, browseFolder, inside, scanFolder } from './scripts/local-library.mjs'

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
const indexPath = library && resolve(library, 'Viewer')
const reviewPath = indexPath && resolve(indexPath, 'selections.json')
const port = Number(process.env.ASSET_VIEWER_PORT || 8177)
const origin = 'http://127.0.0.1:' + port
const identifier = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const fileIdentifier = /^[a-f\d]{24}$/
const statuses = new Set(['candidate', 'later', 'excluded', ''])
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
  '.apng': 'image/apng', '.jpe': 'image/jpeg', '.jfif': 'image/jpeg', '.svg': 'image/svg+xml',
}
let reviewWrites = Promise.resolve()
let viewFiles
let viewFilesUpdated
const folders = new Map()

async function safeFile(base, subpath) {
  const path = resolve(base, subpath)
  if (!inside(base, path)) return null
  const actual = await realpath(path).catch(() => null)
  if (!actual || !inside(base, actual)) return null
  const info = await stat(actual).catch(error => {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null
    throw error
  })
  return info?.isFile() ? { path: actual, size: info.size, modified: info.mtime.toUTCString() } : null
}

function json(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function loadReview() {
  if (!reviewPath) return { version: 1, entries: {} }
  return readFile(reviewPath, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return { version: 1, entries: {} }
    throw error
  })
}

function allowsWrite(request) {
  return request.headers.origin === 'http://' + request.headers.host &&
    request.headers['content-type']?.startsWith('application/json')
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
  const pack = indexPath && await readFile(resolve(indexPath, 'packs', change.pack + '.json'), 'utf8').then(JSON.parse, () => null)
  const file = pack?.files.find(item => item.id === change.file)
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
    const temporary = reviewPath + '.tmp'
    await writeFile(temporary, JSON.stringify(selection, null, 2) + '\n')
    await rename(temporary, reviewPath)
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
  const catalogPath = resolve(library, 'catalog.json')
  const modified = await stat(catalogPath).then(info => info.mtimeMs, () => null)
  if (modified === null) return false
  if (viewFilesUpdated !== modified) {
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
    viewFiles = new Set(catalog.assets.flatMap(asset => asset.files.filter(file => !file.archive).map(file => file.path)))
    viewFilesUpdated = modified
  }
  return viewFiles.has(path)
}

async function openFolder(path) {
  const folder = await scanFolder(path)
  folders.set(folder.id, folder)
  return folder
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
  const folder = folders.get(id)
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
  const extension = extname(file.path).toLowerCase()
  const safeAssetType = asset && ['.html', '.css', '.js', '.mjs', '.wasm'].includes(extension)
  const headers = { 'Content-Type': safeAssetType ? 'application/octet-stream' : (mime[extension] ?? 'application/octet-stream'),
    'Cache-Control': asset ? 'private, max-age=120' : 'no-cache', 'Last-Modified': file.modified, 'Accept-Ranges': 'bytes' }
  if (asset && extension === '.svg') {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '')
  let start = 0
  let end = file.size - 1
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]))
    if (range[1] && range[2]) end = Math.min(end, Number(range[2]))
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      response.writeHead(416, { 'Content-Range': 'bytes */' + file.size }).end()
      return
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`
  }
  headers['Content-Length'] = Math.max(0, end - start + 1)
  response.writeHead(headers['Content-Range'] ? 206 : 200, headers)
  if (request.method === 'HEAD' || !file.size) response.end()
  else await pipeline(createReadStream(file.path, { start, end }), response).catch(error => {
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
  })
}

if (indexPath) await mkdir(indexPath, { recursive: true })
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
    if (request.headers.host !== new URL(origin).host && request.headers.host !== 'localhost:' + port) {
      json(response, 403, { error: 'Доступ только с локального компьютера' })
      return
    }
    let path
    try {
      path = decodeURIComponent(new URL(request.url, origin).pathname)
    } catch {
      json(response, 400, { error: 'Некорректный путь запроса' })
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
      const index = indexPath && await safeFile(indexPath, 'index.json')
      if (index) await sendFile(request, response, index)
      else json(response, 200, { packs: [] })
    } else if (indexPath && path.startsWith('/api/packs/') && identifier.test(path.slice(11))) {
      await sendFile(request, response, await safeFile(indexPath, 'packs/' + path.slice(11) + '.json'))
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
      const folder = folders.get(id)
      const file = folder?.files.get(pieces.join('/'))
      await sendFile(request, response, file && await safeFile(folder.root, file.path), true)
    } else if (path.startsWith('/local-previews/')) {
      const [, , id, file] = path.split('/')
      const preview = await folders.get(id)?.previews.get(file)?.catch(() => null)
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
server.listen(port, '127.0.0.1', () => console.log(`Asset Viewer · ${origin}`))
