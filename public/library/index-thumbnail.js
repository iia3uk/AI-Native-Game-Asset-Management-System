const $ = suffix => document.getElementById('index-thumbnail' + suffix)
const active = status => ['pending', 'running'].includes(status)
const labels = {
  pending: 'Миниатюра в очереди.',
  running: 'Создаю миниатюру…',
  cancelled: 'Создание миниатюры отменено.',
  interrupted: 'Создание миниатюры прервано.',
  failed: 'Не удалось создать миниатюру.',
  missing: '',
  stale: 'Файл или геометрический буфер изменился. Обновите индекс.',
  unavailable: 'Исходный файл или геометрический буфер недоступен.',
  limited: 'Модель превышает допустимый размер для миниатюры.',
}

export function mountIndexThumbnail({ json, post }) {
  const panel = $('')
  const image = $('-image')
  const generate = $('-generate')
  const cancel = $('-cancel')
  const cache = $('-cache')
  const usage = $('-cache-usage')
  const clear = $('-cache-clear')
  let asset
  let current
  let sequence = 0
  let timer

  const path = () => '/api/index/assets/' + asset.id + '/thumbnail'
  const cachePath = '/api/index/thumbnail-cache'
  const formatter = new Intl.NumberFormat('ru', { maximumFractionDigits: 2 })

  function show(preview) {
    current = preview
    panel.hidden = !preview || preview.status === 'unsupported'
    if (preview?.url) {
      if (image.getAttribute('src') !== preview.url) image.src = preview.url
    } else image.removeAttribute('src')
    image.hidden = !preview?.url
    const status = preview?.status
    const message = preview?.job?.cancelRequested && active(status) ? 'Отменяю создание миниатюры…'
      : preview?.job?.error || labels[status] || ''
    if (message !== $('-status').textContent) $('-status').textContent = message
    generate.hidden = !['missing', 'cancelled', 'failed', 'interrupted'].includes(status)
    generate.textContent = status === 'missing' ? 'Создать миниатюру' : 'Повторить создание'
    cancel.hidden = !active(status)
    generate.disabled = false
    cancel.disabled = Boolean(preview?.job?.cancelRequested)
  }

  async function refreshCache(endpoint = cachePath, options) {
    clear.disabled = true
    try {
      const stats = await json(endpoint, options)
      usage.textContent = 'Миниатюр ' + formatter.format(stats.entries) + ' · ' + formatter.format(stats.bytes / 1024 ** 2) +
        ' из ' + formatter.format(stats.limit / 1024 ** 2) + ' МиБ'
    } catch (error) {
      usage.textContent = error.message
    } finally {
      clear.disabled = false
    }
  }

  async function refresh(write) {
    clearTimeout(timer)
    if (!asset || asset.kind !== 'model') return
    const request = ++sequence
    if (write) generate.disabled = cancel.disabled = true
    try {
      if (write) await write()
      if (request !== sequence) return
      const preview = await json(path())
      if (request !== sequence) return
      const wasActive = active(current?.status)
      show(preview)
      if (cache.open && wasActive && !active(preview.status)) void refreshCache()
    } catch (error) {
      if (request !== sequence) return
      panel.hidden = false
      $('-status').textContent = error.message
      generate.disabled = cancel.disabled = false
    } finally {
      if (request === sequence && active(current?.status)) timer = setTimeout(() => void refresh(), 600)
    }
  }

  generate.addEventListener('click', () => {
    const job = current?.job
    void refresh(() => job && job.attempts < 3 ?
      json('/api/index/jobs/' + job.id + '/retry', post({})) : json(path(), post({})))
  })
  cancel.addEventListener('click', () => void refresh(() => json('/api/index/jobs/' + current.job.id + '/cancel', post({}))))
  image.addEventListener('error', () => {
    image.hidden = true
    $('-status').textContent = 'Миниатюра недоступна.'
  })
  cache.addEventListener('toggle', () => { if (cache.open) void refreshCache() })
  clear.addEventListener('click', async () => {
    await refreshCache(cachePath + '/clear', post({}))
    await refresh()
  })

  return {
    select(record) {
      if (record && record.id === asset?.id && record.hash === asset.hash) return
      ++sequence
      clearTimeout(timer)
      asset = record
      show(null)
      void refresh()
    },
    refresh,
  }
}
