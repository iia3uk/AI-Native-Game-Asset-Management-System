import { existsSync } from 'node:fs'
import { AssetIndex, IndexInputError } from '../index/asset-index.mjs'
import { fileInfo, ScanChangeError } from '../files/asset-files.mjs'
import { IndexConflictError } from '../index/index-errors.mjs'
import { LibraryWatcher } from '../processing/library-watcher.mjs'
import { qualityFields } from '../analysis/quality-profiles.mjs'
import { ProcessingWorker } from '../processing/processing-worker.mjs'
import { ThumbnailCache } from '../thumbnails/thumbnail-cache.mjs'
import { assetThumbnail } from '../thumbnails/thumbnail-service.mjs'
import { packageRoutes } from './package-routes.mjs'
import { packageManifestPage } from '../packages/unity/manifest-page.mjs'
import { engineInventory } from '../engines/inventory.mjs'

export function indexRoutes({ database, thumbnailDirectory, importDirectory, ignoredWatchPaths = [],
  json, body, allowsWrite, openFolder, invalidateFolder }) {
  let pendingIndex
  let worker
  let thumbnails
  let importer
  let watcher
  const cache = new ThumbnailCache(thumbnailDirectory)
  const shutdown = new AbortController()
  const packages = packageRoutes({ json, body, shutdown: shutdown.signal, wake: () => importer?.wake() })
  let currentInventory

  function openIndex() {
    return pendingIndex ??= AssetIndex.open(database).then(index => {
      if (!shutdown.signal.aborted) {
        const queuePackages = () => {
          if (index.jobs.refillWatchedImports(ignoredWatchPaths)) importer?.wake()
        }
        worker = new ProcessingWorker(index, {
          onScanComplete(id) {
            invalidateFolder(id)
            queuePackages()
          },
        })
        thumbnails = new ProcessingWorker(index, { type: 'thumbnail', cache })
        importer = new ProcessingWorker(index, { type: 'package-import', importDirectory,
          onImportComplete: () => worker.wake(), onImportSettled: queuePackages })
        watcher = new LibraryWatcher(index, () => worker.wake(), { ignoredPaths: ignoredWatchPaths, onRefresh: queuePackages })
        void cache.maintain().catch(error => console.error('Thumbnail cache:', error.message))
      }
      return index
    }).catch(error => {
      pendingIndex = undefined
      throw error
    })
  }

  async function handle(request, response, path) {
    const [, , , resource, id, action, extra] = path.split('/')
    const params = new URL(request.url, 'http://127.0.0.1').searchParams
    const method = request.method
    if (extra !== undefined || !['GET', 'POST'].includes(method)) return json(response, 404, { error: 'Маршрут отсутствует.' })
    if (method === 'POST' && !allowsWrite(request)) return json(response, 403, { error: 'Недопустимый источник запроса' })

    if (shutdown.signal.aborted) return json(response, 503, { error: 'Сервер завершает работу.' })
    if (method === 'GET' && resource === 'engines' && !id && !action) {
      currentInventory ??= engineInventory().finally(() => { currentInventory = null })
      return json(response, 200, await currentInventory)
    }
    let index
    try {
      index = await openIndex()
    } catch (error) {
      console.error('Asset index:', error.message)
      return json(response, 503, { error: 'Индекс недоступен. Проверьте каталог данных и резервные копии.' })
    }
    try {
      if (method === 'POST' && resource === 'packages' && !action && ['inspect', 'import'].includes(id)) {
        return await packages(index, request, response, id)
      }
      if (method === 'GET' && resource === 'libraries' && !id) return json(response, 200, { libraries: index.libraries() })
      if (method === 'POST' && resource === 'libraries' && !id) {
        const input = await body(request).catch(() => null)
        return json(response, 201, { library: await index.connect(input?.path) })
      }
      if (method === 'POST' && resource === 'libraries' && id && ['scan', 'jobs'].includes(action)) {
        const job = index.jobs.enqueue(id)
        if (!job) return json(response, 400, { error: 'Библиотека не подключена.' })
        worker?.wake()
        if (action === 'jobs') return json(response, 202, { job })
        const finished = await worker?.wait(job.id, shutdown.signal)
        if (finished?.status === 'completed') return json(response, 200, finished.result)
        return json(response, 409, { error: finished?.error ?? 'Сканирование прервано.', job: finished })
      }
      if (method === 'POST' && resource === 'libraries' && action === 'disconnect') {
        const disconnected = index.disconnect(id)
        watcher?.refresh()
        invalidateFolder(id)
        return json(response, 200, { disconnected })
      }
      if (method === 'POST' && resource === 'libraries' && ['watch', 'package-watch'].includes(action)) {
        const input = await body(request).catch(() => null)
        const library = action === 'watch' ? index.setWatching(id, input?.enabled) :
          index.setPackageWatching(id, input?.enabled, ignoredWatchPaths)
        watcher?.refresh()
        return json(response, 200, { library })
      }
      if (resource === 'jobs') {
        if (method === 'GET' && !id) {
          const limit = Number(params.get('limit') ?? 50)
          const offset = Number(params.get('offset') ?? 0)
          const type = params.get('type')
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 ||
              (type !== null && !['scan', 'thumbnail', 'package-import'].includes(type))) {
            return json(response, 400, { error: 'Недопустимые параметры страницы.' })
          }
          return json(response, 200, { jobs: index.jobs.list({ libraryId: params.get('library'), type, limit, offset }) })
        }
        if (method === 'GET' && id && !action) {
          const job = index.jobs.get(id)
          if (job) return json(response, 200, { job })
        }
        if (method === 'GET' && id && action === 'manifest') {
          const page = await packageManifestPage(importDirectory, index.jobs.get(id),
            Number(params.get('offset') ?? 0), Number(params.get('limit') ?? 50))
          if (page) return json(response, 200, page)
        }
        if (method === 'POST' && id && action === 'cancel') {
          const job = index.jobs.cancel(id)
          if (job) return json(response, 200, { job })
        }
        if (method === 'POST' && id && action === 'retry') {
          const job = index.jobs.retry(id)
          if (!job) return json(response, 409, { error: 'Задание недоступно для повторного запуска.' })
          if (job.type === 'thumbnail') thumbnails?.wake()
          else if (job.type === 'package-import') importer?.wake()
          else worker?.wake()
          return json(response, 202, { job })
        }
      }
      if (resource === 'thumbnail-cache') {
        if (method === 'GET' && !id) return json(response, 200, await cache.usage())
        if (method === 'POST' && id === 'clear' && !action) return json(response, 200, await cache.clear())
      }
      if (resource === 'assets' && id && action === 'thumbnail') {
        const preview = await assetThumbnail(index, cache, id, { enqueue: method === 'POST' })
        if (!preview) return json(response, 404, { error: 'Ассет недоступен.' })
        const { status, key, job, format, size } = preview
        if (method === 'POST' && job) thumbnails?.wake()
        const url = status === 'available' ? '/api/index/assets/' + id + '/thumbnail-image?v=' + key : undefined
        return json(response, method === 'POST' && job ? 202 : 200, { status, job, format, size, url })
      }
      if (resource === 'assets' && id && action === 'thumbnail-image' && method === 'GET') {
        const preview = await assetThumbnail(index, cache, id)
        if (preview?.status === 'available' && params.get('v') === preview.key) {
          const image = await cache.read(preview.key)
          if (image) {
            response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, 'Cache-Control': 'no-store' })
            return response.end(image)
          }
        }
      }
      if (method === 'GET' && resource === 'search' && !id) {
        return json(response, 200, index.search({
          q: params.get('q') ?? '', libraryId: params.get('library'), kind: params.get('kind'),
          limit: Number(params.get('limit') ?? 50), offset: Number(params.get('offset') ?? 0),
        }))
      }
      if (method === 'GET' && resource === 'duplicates' && !id) {
        return json(response, 200, { groups: index.duplicates(Number(params.get('limit') ?? 50), Number(params.get('offset') ?? 0)) })
      }
      if (resource === 'quality-profiles' && !action) {
        if (method === 'GET' && !id) return json(response, 200, { profiles: index.qualityProfiles.list(), fields: qualityFields })
        if (method === 'POST' && id) {
          const profile = index.qualityProfiles.update(id, await body(request).catch(() => null))
          return json(response, 200, { profile })
        }
      }
      if (resource === 'assets' && id && !action) {
        if (method === 'POST') return json(response, 200, { asset: index.updateAsset(id, await body(request).catch(() => null)) })
        const details = index.inspect(id, { profileId: params.get('profile') ?? undefined })
        if (details) return json(response, 200, details)
      }
      if (method === 'POST' && resource === 'assets' && id && action === 'open') {
        const asset = index.asset(id)
        if (!asset || asset.missingSince || !await fileInfo(asset.root, asset.path)) {
          return json(response, 404, { error: 'Исходный файл недоступен.' })
        }
        const folder = await openFolder(asset)
        const file = folder.files.get(asset.path)
        if (file) {
          const pack = [...folder.packs.values()].find(pack => pack.files.includes(file))
          return json(response, 200, { folder: folder.info, groupId: pack.summary.id, fileId: file.id })
        }
      }
      return json(response, 404, { error: 'Запись или маршрут отсутствуют.' })
    } catch (error) {
      if (shutdown.signal.aborted) return json(response, 503, { error: 'Сервер завершает работу.' })
      if (error instanceof IndexInputError) return json(response, 400, { error: error.message })
      if (error instanceof IndexConflictError) return json(response, 409, { error: error.message })
      if (error instanceof ScanChangeError) return json(response, 409, { error: error.message })
      if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) {
        return json(response, 409, { error: 'Каталог или файл недоступен. Проверьте путь и повторите операцию.' })
      }
      throw error
    }
  }

  return {
    handle,
    startExisting() {
      if (existsSync(database)) void openIndex().catch(error => console.error('Asset index:', error.message))
    },
    abort() {
      shutdown.abort()
      void watcher?.stop()
      void worker?.stop()
      void thumbnails?.stop()
      void importer?.stop()
    },
    async close() {
      const index = await pendingIndex
      await watcher?.stop()
      await importer?.stop()
      await worker?.stop()
      await thumbnails?.stop()
      await index?.close()
    },
  }
}
