import { mountQualityProfile } from './quality-profile.js'
import { mountIndexThumbnail } from './index-thumbnail.js'
import { mountPackageImporter } from '../package-importer/index.js'
import { mountPackageWatch } from './package-watch.js'

const $ = id => document.getElementById('index-' + id)
const number = new Intl.NumberFormat('ru')
const decimal = new Intl.NumberFormat('ru', { maximumFractionDigits: 4 })

const analysisStatus = {
  analyzed: 'Анализ выполнен.',
  partial: 'Часть данных недоступна.',
  invalid: 'Ошибка в структуре файла или неподдерживаемая версия формата.',
  limited: 'Часть файла недоступна для анализа.',
  pending: 'Данные появятся после следующего сканирования.',
  unsupported: 'Технический анализ для этого формата пока недоступен.',
}
const analysisIssue = {
  'incomplete-geometry': 'Не удалось определить часть геометрии.',
  'invalid-material-reference': 'В модели есть ссылка на отсутствующий материал.',
  'invalid-material-library': 'У файла материалов повреждена структура.',
  'invalid-skin-reference': 'В скелете есть ссылка на отсутствующий узел.',
  'invalid-geometry-reference': 'В модели есть некорректные координаты или индексы вершин.',
  'invalid-uv-reference': 'В модели есть некорректные ссылки на UV-координаты.',
  'unsupported-obj-surfaces': 'Файл содержит кривые или поверхности, для которых число граней неизвестно.',
  'unreadable-texture-reference': 'Не удалось разобрать часть ссылок на текстуры.',
  'analysis-size-limit': 'Файл превысил ограничение размера для технического анализа.',
  'image-dimensions-unknown': 'В доступной части заголовка размер изображения не найден.',
}
const dependencyStatus = {
  available: 'в индексе', unavailable: 'отсутствует в индексе', unindexed: 'формат вне индекса',
  embedded: 'встроен', outside: 'вне библиотеки', external: 'внешний адрес', unresolved: 'не удалось разрешить',
}
const dependencyRole = { image: 'Изображение', buffer: 'Буфер', 'material-library': 'Библиотека материалов' }

function addTerms(list, terms) {
  for (const [label, value] of terms) {
    const term = document.createElement('dt')
    const description = document.createElement('dd')
    term.textContent = label
    description.textContent = value
    list.append(term, description)
  }
}

function renderAnalysis(analysis, { keepOpen = false } = {}) {
  const panel = $('analysis')
  const metrics = $('metrics')
  const dependencies = $('dependencies')
  metrics.replaceChildren()
  dependencies.replaceChildren()
  if (!keepOpen) panel.open = false
  if (!analysis) return
  const { status, issues, metrics: values, dependenciesTruncated } = analysis
  $('analysis-status').textContent = [analysisStatus[status], ...issues.map(issue => analysisIssue[issue]).filter(Boolean),
    dependenciesTruncated ? 'Показана часть зависимостей.' : ''].filter(Boolean).join(' ')
  const labels = {
    vertices: 'Вершины', triangles: 'Треугольники', meshes: 'Меши', materials: 'Материалы', textures: 'Текстуры',
    hasUV: 'UV', skins: 'Скелеты', bones: 'Кости', animations: 'Клипы', lod: 'Признаки LOD',
    collisionNamed: 'Признаки коллизий по именам',
  }
  const valueText = value => value === null ? 'Неизвестно' : typeof value === 'boolean' ?
    value ? 'Обнаружены' : 'Не обнаружены' : number.format(value)
  addTerms(metrics, Object.entries(labels).filter(([key]) => key in values)
    .map(([key, label]) => [label, valueText(values[key])]))
  if (values.width && values.height) addTerms(metrics, [['Размер изображения', values.width + ' × ' + values.height + ' px']])
  if ('bounds' in values) {
    const axis = value => value.map(component => decimal.format(component)).join(' × ')
    const box = values.bounds
    const label = box?.kind === 'scene-aabb' ? 'Охватывающие габариты сцены' : 'Габариты'
    addTerms(metrics, [[label, box ? axis(box.size) : 'Неизвестно']])
    if (box) addTerms(metrics, [['Границы XYZ', '[' + axis(box.min) + '] … [' + axis(box.max) + ']']])
  }
  for (const { role, status, path, via, dimensions } of analysis.dependencies) {
    const item = document.createElement('li')
    const source = path ? ' — ' + path : ''
    const viaText = via ? ' через ' + via : ''
    const size = dimensions ? ' · ' + dimensions.width + ' × ' + dimensions.height + ' px' : ''
    item.textContent = dependencyRole[role] + source + viaText + ' · ' + dependencyStatus[status] + size
    dependencies.append(item)
  }
}

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
  const quality = mountQualityProfile({ json, post, run, currentAsset: () => asset?.id })
  const thumbnail = mountIndexThumbnail({ json, post })
  const packages = mountPackageImporter({ dialog, json, post,
    hasWatchedLibraries: () => libraries.some(library => library.packageWatchFormats.length),
    openLibrary: id => run(async () => {
      await refreshLibraries(id)
      query.value = $('kind').value = ''
      await search()
      await refreshJob()
    }),
  })

  const activeJob = () => ['pending', 'running'].includes(job?.status)
  const selectedLibrary = () => libraries.find(library => library.id === selection.value)
  const watching = () => Boolean(selectedLibrary()?.watching)
  const observing = () => watching() || Boolean(selectedLibrary()?.packageWatchFormats.length)
  const packageWatch = mountPackageWatch($('package-autoimport'), (format, label) => void run(async () => {
    const id = selection.value
    const enabled = !selectedLibrary()?.packageWatchFormats.includes(format)
    const { library } = await json('/api/index/libraries/' + id + '/package-watch', post({ enabled, format }))
    await refreshLibraries(id)
    await refreshJob()
    const active = library.packageWatchFormats.includes(format)
    status.textContent = 'Автоимпорт ' + label + (active ? ' включён. Задания появятся в разделе импорта.' : ' выключен.')
    if (active) document.getElementById('package-importer').open = true
    void packages.refresh()
  }))

  function buttons() {
    quality.busy(busy)
    $('connect').querySelector('button:not([type])').disabled = busy
    $('pick').disabled = busy
    $('query').querySelector('button').disabled = busy
    selection.disabled = $('kind').disabled = busy
    for (const id of ['rescan', 'watch', 'disconnect']) $(id).disabled = busy || !selection.value
    $('watch').setAttribute('aria-pressed', String(watching()))
    packageWatch.update(selectedLibrary(), busy)
    $('rescan').disabled ||= activeJob()
    $('cancel-scan').disabled = busy || Boolean(job?.cancelRequested)
    $('retry-scan').disabled = busy
    $('prev').disabled = busy || offset === 0
    $('next').disabled = busy || nextOffset === null
    $('preview').disabled = busy || !asset || Boolean(asset.missingSince)
    details.querySelector('button[type="submit"], button:not([type])').disabled = busy
    results.setAttribute('aria-busy', String(busy))
  }

  async function run(action, { clearStatus = true } = {}) {
    if (busy) return
    busy = true
    buttons()
    if (clearStatus) status.textContent = ''
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
    quality.visible(Boolean(record))
    thumbnail.select(record)
    if (!record) return
    $('name').textContent = record.name
    const info = $('file-info')
    info.replaceChildren()
    addTerms(info, [
      ['Путь', record.path],
      ['Размер', number.format(record.size) + ' Б'],
      ['SHA-256', record.hash ?? 'Не рассчитан'],
      ['Доступность', record.missingSince ? 'Исходный файл отсутствует' : 'В индексе'],
    ])
    for (const field of ['category', 'license', 'note', 'review']) details.elements[field].value = record[field]
    details.elements.tags.value = record.tags.join(', ')
  }

  async function search(from = 0, { preserveAsset = false } = {}) {
    const params = new URLSearchParams({ q: query.value, library: selection.value, kind: $('kind').value, offset: from })
    const page = await json('/api/index/search?' + params)
    offset = from
    nextOffset = page.nextOffset
    if (!preserveAsset) setAsset(null)
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
    const poll = activeJob() ? 500 : observing() ? 2000 : 0
    if (poll && dialog.open) pollTimer = setTimeout(() => void pollJob(), poll)
    if (!job) return
    const messages = {
      pending: 'Сканирование в очереди.',
      running: 'Проверено файлов: ' + number.format(job.progress),
      cancelled: 'Сканирование отменено.',
      interrupted: 'Сканирование прервано. Задание можно запустить повторно.',
      failed: job.error,
    }
    const report = job.result
    const text = job.cancelRequested && activeJob() ? 'Отменяю сканирование…' :
      report ? 'Добавлено: ' + report.added + ' · Изменено: ' + report.changed +
        ' · Перемещено: ' + report.moved + ' · Отсутствует: ' + report.missing : messages[job.status]
    if (text !== output.textContent) output.textContent = text
  }

  async function pollJob() {
    if (!dialog.open || !selection.value) return
    if (busy) {
      pollTimer = setTimeout(() => void pollJob(), 500)
      return
    }
    await run(async () => {
      try {
        const previous = job
        if (activeJob()) {
          const { job: current } = await json('/api/index/jobs/' + previous.id)
          showJob(current)
        } else await refreshJob()
        if (job?.status === 'completed' && (job.id !== previous?.id || previous?.status !== 'completed')) {
          await refreshLibraries(job.libraryId)
          // Automatic scans must not dismiss metadata fields while the user is editing them.
          const automatic = job.trigger === 'watch'
          await search(automatic ? offset : 0, { preserveAsset: automatic })
          if (automatic && asset) {
            const { analysis, validation } = await json(quality.assetUrl(asset.id))
            renderAnalysis(analysis, { keepOpen: true })
            quality.show(validation)
            void thumbnail.refresh()
          }
        }
      } catch (error) {
        clearTimeout(pollTimer)
        if ((activeJob() || observing()) && dialog.open) pollTimer = setTimeout(() => void pollJob(), 1500)
        throw error
      }
    }, { clearStatus: false })
  }

  async function refreshJob() {
    if (!selection.value) return showJob(null)
    const params = new URLSearchParams({ library: selection.value, limit: 1, type: 'scan' })
    const { jobs } = await json('/api/index/jobs?' + params)
    showJob(jobs[0])
  }

  $('mode').addEventListener('click', () => {
    const root = currentFolder()
    if (root && !$('root').value) $('root').value = root
    dialog.showModal()
    void packages.refresh()
    void run(async () => { await refreshLibraries(); await search(); await refreshJob() })
  })
  $('close').addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    if (dialog.open) return
    clearTimeout(pollTimer)
    thumbnail.select(null)
  })
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
  $('watch').addEventListener('click', () => void run(async () => {
    const id = selection.value
    const { library } = await json('/api/index/libraries/' + id + '/watch', post({ enabled: !watching() }))
    await refreshLibraries(id)
    await refreshJob()
    if (library.watching && job?.status === 'completed') {
      await refreshLibraries(id)
      await search(offset, { preserveAsset: true })
    }
    status.textContent = library.watching ? 'Наблюдение за папкой включено.' : 'Наблюдение за папкой выключено.'
  }))
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
      const { asset: record, analysis, validation } = await json(quality.assetUrl(id))
      setAsset(record)
      renderAnalysis(analysis)
      quality.show(validation)
      await quality.load()
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
