import { AssetIndex, IndexInputError } from './asset-index.mjs'
import { fileInfo, ScanChangeError } from './asset-files.mjs'

export function indexRoutes({ database, json, body, allowsWrite, openFolder, invalidateFolder }) {
  let pendingIndex
  const shutdown = new AbortController()

  async function handle(request, response, path) {
    const [, , , resource, id, action, extra] = path.split('/')
    const params = new URL(request.url, 'http://127.0.0.1').searchParams
    const method = request.method
    if (extra !== undefined || !['GET', 'POST'].includes(method)) return json(response, 404, { error: 'Маршрут отсутствует.' })
    if (method === 'POST' && !allowsWrite(request)) return json(response, 403, { error: 'Недопустимый источник запроса' })

    pendingIndex ??= AssetIndex.open(database).catch(error => {
      pendingIndex = undefined
      throw error
    })
    let index
    try {
      index = await pendingIndex
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
      if (method === 'POST' && resource === 'libraries' && action === 'scan') {
        const result = await index.scan(id, { signal: shutdown.signal })
        invalidateFolder(id)
        return json(response, 200, result)
      }
      if (method === 'POST' && resource === 'libraries' && action === 'disconnect') {
        const disconnected = index.disconnect(id)
        invalidateFolder(id)
        return json(response, 200, { disconnected })
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
      if (resource === 'assets' && id && !action) {
        if (method === 'POST') return json(response, 200, { asset: index.updateAsset(id, await body(request).catch(() => null)) })
        const asset = index.asset(id)
        if (asset) return json(response, 200, { asset, versions: index.versions(id) })
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
      if (error instanceof IndexInputError) return json(response, 400, { error: error.message })
      if (error instanceof ScanChangeError) return json(response, 409, { error: error.message })
      if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) {
        return json(response, 409, { error: 'Каталог или файл недоступен. Проверьте путь и повторите операцию.' })
      }
      throw error
    }
  }

  return { handle, abort: () => shutdown.abort(), close: async () => await (await pendingIndex)?.close() }
}
