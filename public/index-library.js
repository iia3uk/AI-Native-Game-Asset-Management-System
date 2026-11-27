const $ = id => document.getElementById('index-' + id)
const number = new Intl.NumberFormat('ru')

export function mountIndex({ json, post, openPreview, currentFolder }) {
  const dialog = $('dialog')
  const details = $('metadata')
  const results = $('results')
  const status = $('status')
  const query = $('search')
  const selection = $('library')
  let libraries = []
  let asset
  let offset = 0
  let nextOffset = null
  let busy = false
  let job
  let pollTimer

  const activeJob = () => ['pending', 'running'].includes(job?.status)

  function buttons() {
    $('connect').querySelector('button:not([type])').disabled = busy
    $('pick').disabled = busy
    $('query').querySelector('button').disabled = busy
    selection.disabled = $('kind').disabled = busy
    for (const id of ['rescan', 'disconnect']) $(id).disabled = busy || !selection.value
    $('rescan').disabled ||= activeJob()
    $('cancel-scan').disabled = busy || Boolean(job?.cancelRequested)
    $('retry-scan').disabled = busy
    $('prev').disabled = busy || offset === 0
    $('next').disabled = busy || nextOffset === null
    $('preview').disabled = busy || !asset || Boolean(asset.missingSince)
    details.querySelector('button[type="submit"], button:not([type])').disabled = busy
    results.setAttribute('aria-busy', String(busy))
  }

  async function run(action) {
    if (busy) return
    busy = true
    buttons()
    status.textContent = ''
    try {
      await action()
    } catch (error) {
      status.textContent = error.message
    } finally {
      busy = false
      buttons()
    }
  }

  async function refreshLibraries(preferred = selection.value) {
    ({ libraries } = await json('/api/index/libraries'))
    selection.replaceChildren(new Option('Все библиотеки', ''), ...libraries.map(library =>
      new Option(library.root, library.id)))
    if (libraries.some(library => library.id === preferred)) selection.value = preferred
    const count = libraries.filter(library => !selection.value || selection.value === library.id)
      .reduce((sum, library) => sum + library.assets, 0)
    $('count').textContent = number.format(count) + ' файлов в индексе'
  }

  function setAsset(record) {
    asset = record
    details.hidden = !record
    if (!record) return
    $('name').textContent = record.name
    const info = $('file-info')
    info.replaceChildren()
    for (const [label, value] of [
      ['Путь', record.path],
      ['Размер', number.format(record.size) + ' Б'],
      ['SHA-256', record.hash ?? 'Не рассчитан'],
      ['Доступность', record.missingSince ? 'Исходный файл отсутствует' : 'В индексе'],
    ]) {
      const term = document.createElement('dt')
      const description = document.createElement('dd')
      term.textContent = label
      description.textContent = value
      info.append(term, description)
    }
    for (const field of ['category', 'license', 'note', 'review']) details.elements[field].value = record[field]
    details.elements.tags.value = record.tags.join(', ')
  }

  async function search(from = 0) {
    const params = new URLSearchParams({ q: query.value, library: selection.value, kind: $('kind').value, offset: from })
    const page = await json('/api/index/search?' + params)
    offset = from
    nextOffset = page.nextOffset
    setAsset(null)
    results.replaceChildren()
    if (!page.assets.length) {
      const empty = document.createElement('li')
      empty.className = 'notice'
      empty.textContent = libraries.length ? 'Файлы по этому запросу не найдены.' : 'Подключите папку с ассетами.'
      results.append(empty)
    }
    for (const item of page.assets) {
      const entry = document.createElement('li')
      const button = document.createElement('button')
      const path = document.createElement('small')
      button.type = 'button'
      button.className = 'control'
      button.dataset.id = item.id
      button.textContent = item.name
      path.textContent = item.library + ' / ' + item.path
      button.append(path)
      entry.append(button)
      results.append(entry)
    }
  }

  async function scan(id) {
    const { job: queued } = await json('/api/index/libraries/' + id + '/jobs', post({}))
    showJob(queued)
  }

  function showJob(record) {
    clearTimeout(pollTimer)
    job = record
    const output = $('job-status')
    output.hidden = !job
    $('cancel-scan').hidden = !activeJob()
    $('retry-scan').hidden = !['failed', 'interrupted', 'cancelled'].includes(job?.status) || job.attempts >= 3
    buttons()
    if (!job) return
    const messages = {
      pending: 'Сканирование в очереди.',
      running: 'Проверено файлов: ' + number.format(job.progress),
      cancelled: 'Сканирование отменено.',
      interrupted: 'Сканирование прервано. Задание можно запустить повторно.',
      failed: job.error,
    }
    const report = job.result
    output.textContent = job.cancelRequested && activeJob() ? 'Отменяю сканирование…' :
      report ? 'Добавлено: ' + report.added + ' · Изменено: ' + report.changed +
        ' · Перемещено: ' + report.moved + ' · Отсутствует: ' + report.missing : messages[job.status]
    if (activeJob() && dialog.open) pollTimer = setTimeout(() => void pollJob(job.id), 500)
  }

  async function pollJob(id) {
    if (!dialog.open || job?.id !== id) return
    if (busy) {
      pollTimer = setTimeout(() => void pollJob(id), 500)
      return
    }
    await run(async () => {
      try {
        const { job: current } = await json('/api/index/jobs/' + id)
        showJob(current)
        if (current.status === 'completed') { await refreshLibraries(current.libraryId); await search() }
      } catch (error) {
        if (activeJob() && dialog.open) pollTimer = setTimeout(() => void pollJob(id), 1500)
        throw error
      }
    })
  }

  async function refreshJob() {
    if (!selection.value) return showJob(null)
    const params = new URLSearchParams({ library: selection.value, limit: 1 })
    const { jobs } = await json('/api/index/jobs?' + params)
    showJob(jobs[0])
  }

  $('mode').addEventListener('click', () => {
    const root = currentFolder()
    if (root && !$('root').value) $('root').value = root
    dialog.showModal()
    void run(async () => { await refreshLibraries(); await search(); await refreshJob() })
  })
  $('close').addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => clearTimeout(pollTimer))
  if (window.assetViewerDesktop) {
    $('pick').hidden = false
    $('pick').addEventListener('click', () => void run(async () => {
      const path = await window.assetViewerDesktop.chooseFolder()
      if (path) $('root').value = path
    }))
  }
  $('connect').addEventListener('submit', event => {
    event.preventDefault()
    void run(async () => {
      const { library } = await json('/api/index/libraries', post({ path: $('root').value }))
      $('root').value = ''
      await refreshLibraries(library.id)
      await scan(library.id)
    })
  })
  $('query').addEventListener('submit', event => { event.preventDefault(); void run(() => search()) })
  selection.addEventListener('change', () => void run(async () => { await refreshLibraries(); await search(); await refreshJob() }))
  $('kind').addEventListener('change', () => void run(() => search()))
  $('rescan').addEventListener('click', () => void run(() => scan(selection.value)))
  $('cancel-scan').addEventListener('click', () => void run(async () => {
    const { job: current } = await json('/api/index/jobs/' + job.id + '/cancel', post({}))
    showJob(current)
  }))
  $('retry-scan').addEventListener('click', () => void run(async () => {
    const { job: current } = await json('/api/index/jobs/' + job.id + '/retry', post({}))
    showJob(current)
  }))
  $('disconnect').addEventListener('click', () => void run(async () => {
    await json('/api/index/libraries/' + selection.value + '/disconnect', post({}))
    await refreshLibraries('')
    await search()
    showJob(null)
  }))
  $('prev').addEventListener('click', () => void run(() => search(Math.max(0, offset - 50))))
  $('next').addEventListener('click', () => void run(() => search(nextOffset)))
  results.addEventListener('click', event => {
    const id = event.target.closest('button')?.dataset.id
    if (id) void run(async () => {
      const { asset: record } = await json('/api/index/assets/' + id)
      setAsset(record)
      details.scrollIntoView({ block: 'nearest' })
    })
  })
  details.addEventListener('submit', event => {
    event.preventDefault()
    if (!asset) return
    void run(async () => {
      const { category, tags, review, license, note } = Object.fromEntries(new FormData(details))
      const { asset: record } = await json('/api/index/assets/' + asset.id,
        post({ category, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean), review, license, note }))
      setAsset(record)
      status.textContent = 'Метаданные сохранены в индексе.'
    })
  })
  $('preview').addEventListener('click', () => void run(async () => {
    const preview = await json('/api/index/assets/' + asset.id + '/open', post({}))
    dialog.close()
    await openPreview(preview)
  }))
}
