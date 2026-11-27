import { existsSync } from 'node:fs'
import { AssetIndex, IndexInputError } from './asset-index.mjs'
import { fileInfo, ScanChangeError } from './asset-files.mjs'
import { IndexConflictError } from './index-errors.mjs'
import { LibraryWatcher } from './library-watcher.mjs'
import { qualityFields } from './quality-profiles.mjs'
import { ScanWorker } from './scan-worker.mjs'

export function indexRoutes({ database, ignoredWatchPaths, json, body, allowsWrite, openFolder, invalidateFolder }) {
  let pendingIndex
  let worker
  let watcher
  const shutdown = new AbortController()

  function openIndex() {
    return pendingIndex ??= AssetIndex.open(database).then(index => {
      if (!shutdown.signal.aborted) {
        worker = new ScanWorker(index, invalidateFolder)
        watcher = new LibraryWatcher(index, () => worker.wake(), { ignoredPaths: ignoredWatchPaths })
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
    let index
    try {
      index = await openIndex()
    } catch (error) {
      console.error('Asset index:', error.message)
      return json(response, 503, { error: 'Индекс недоступен. Проверьте каталог данных и резервные копии.' })
    }
    try {
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
      if (method === 'POST' && resource === 'libraries' && action === 'watch') {
        const input = await body(request).catch(() => null)
        const library = index.setWatching(id, input?.enabled)
        watcher?.refresh()
        return json(response, 200, { library })
      }
      if (resource === 'jobs') {
        if (method === 'GET' && !id) {
          const limit = Number(params.get('limit') ?? 50)
          const offset = Number(params.get('offset') ?? 0)
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) {
            return json(response, 400, { error: 'Недопустимые параметры страницы.' })
          }
          return json(response, 200, { jobs: index.jobs.list({ libraryId: params.get('library'), limit, offset }) })
        }
        if (method === 'GET' && id && !action) {
          const job = index.jobs.get(id)
          if (job) return json(response, 200, { job })
        }
        if (method === 'POST' && id && action === 'cancel') {
          const job = index.jobs.cancel(id)
          if (job) return json(response, 200, { job })
        }
        if (method === 'POST' && id && action === 'retry') {
          const job = index.jobs.retry(id)
          if (!job) return json(response, 409, { error: 'Задание недоступно для повторного запуска.' })
          worker?.wake()
          return json(response, 202, { job })
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
    },
    async close() {
      const index = await pendingIndex
      await watcher?.stop()
      await worker?.stop()
      await index?.close()
    },
  }
}
