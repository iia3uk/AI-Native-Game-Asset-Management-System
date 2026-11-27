import { mountEngineStatus } from './engine-status.js'
import { appendManifest, describeIssue } from './report.js'
import { mountImportOptions } from './import-options.js'

const $ = name => document.getElementById('package-' + name)
const jobsRoute = '/api/index/jobs'
const packagesRoute = '/api/index/packages'
const active = job => ['pending', 'running'].includes(job.status)
const assetStatus = {
  ready: 'Готово', extracted: 'Прямое извлечение', unsupported: 'Не поддерживается',
  'requires-engine': 'Требуется обработчик Unity', failed: 'Файл отсутствует',
  'missing-dependencies': 'Отсутствуют зависимости', converted: 'Сконвертировано',
}
const jobStatus = {
  pending: 'В очереди', running: 'Обработка', completed: 'Обработан',
  cancelled: 'Отменён', interrupted: 'Прерван', failed: 'Ошибка',
}

function element(tag, text) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  return node
}

function button(text, action) {
  const node = element('button', text)
  node.type = 'button'
  node.className = 'control'
  node.addEventListener('click', action)
  return node
}

export function mountPackageImporter({ dialog, json, post, openLibrary }) {
  mountEngineStatus({ json })
  const importOptions = mountImportOptions($)
  const section = $('importer')
  const plans = $('plans')
  const jobs = $('jobs')
  const status = $('status')
  const pathInput = $('path')
  const fileInput = $('files')
  const startAll = $('start-all')
  const queuedPlans = new Map()
  const bridge = window.assetViewerDesktop
  let timer
  let busy = false

  const visible = () => dialog.open && section.open
  function showError(error) {
    status.textContent = error.message
  }

  async function refresh() {
    clearTimeout(timer)
    if (!visible()) return
    try {
      const { jobs: records } = await json(jobsRoute + '?type=package-import&limit=16')
      const rows = await Promise.all(records.map(async record => {
        const scan = record.result?.scanJobId
          ? (await json(jobsRoute + '/' + record.result.scanJobId)).job : null
        return { record, scan }
      }))
      if (!visible()) return
      jobs.replaceChildren(...rows.map(jobRow))
      if (rows.some(({ record, scan }) => active(record) || (scan && active(scan)))) {
        timer = setTimeout(() => void refresh(), 1000)
      }
    } catch (error) {
      showError(error)
      if (visible()) timer = setTimeout(() => void refresh(), 3000)
    }
  }

  function jobRow({ record, scan }) {
    const row = element('li')
    row.className = 'index-analysis'
    let label = jobStatus[record.status]
    if (active(record) && record.cancelRequested) label = 'Отмена запрошена'
    else if (record.status === 'running') label += ' · ' + record.progress + '%'
    if (scan) label += ' · ' + (active(scan) ? 'Индексация' : scan.status === 'completed' ? 'В индексе' : 'Индексация прервана')
    row.append(element('p', record.packageName + ' · ' + label))
    if (record.error || scan?.error) row.append(element('p', record.error ?? scan.error))
    const controls = element('div')
    controls.className = 'index-toolbar'
    if (active(record) && !record.cancelRequested) controls.append(jobButton('Отменить', record, 'cancel'))
    if (['failed', 'interrupted', 'cancelled'].includes(record.status) && record.attempts < 3) {
      controls.append(jobButton('Повторить', record, 'retry'))
    }
    if (scan && !active(scan)) {
      controls.append(button('Показать в индексе', () => void openLibrary(record.libraryId).catch(showError)))
    }
    if (record.result) {
      const details = element('details')
      details.append(element('summary', 'Отчёт об импорте'),
        element('p', Object.entries(record.result.report.counts).map(([key, value]) =>
          (assetStatus[key] ?? key) + ' · ' + value).join(' / ')),
        element('p', record.result.directory))
      const materials = record.result.report.materials
      if (materials?.written) details.append(element('p', 'Описаний материалов · ' + materials.written))
      if (record.result.report.export) {
        details.append(element('p', 'Моделей сконвертировано · ' + record.result.report.converted))
      }
      const unity = record.result.report.export?.unity
      if (unity?.status === 'completed') details.append(element('p', 'Unity Editor ' + unity.editorVersion))
      else if (unity?.issue) details.append(element('p', 'Unity Editor · ' + describeIssue(unity.issue)))
      appendManifest({ details, record, json, element, button, assetStatus })
      row.append(details)
    }
    row.append(controls)
    return row
  }

  function jobButton(title, record, action) {
    return button(title, event => {
      event.currentTarget.disabled = true
      void json(jobsRoute + '/' + record.id + '/' + action, post({})).then(refresh, error => {
        showError(error)
        void refresh()
      })
    })
  }

  async function queuePlan(path, plan, options) {
    await json(packagesRoute + '/import', post({ path, hash: plan.hash, ...options }))
    queuedPlans.get(path)?.row.remove()
    queuedPlans.delete(path)
    startAll.hidden = queuedPlans.size < 2
  }

  startAll.addEventListener('click', async () => {
    if (busy) return
    busy = startAll.disabled = true
    const options = importOptions()
    try {
      for (const [path, { plan, start }] of queuedPlans) {
        start.disabled = true
        try { await queuePlan(path, plan, options) }
        catch (error) { showError(error); start.disabled = false }
      }
      await refresh()
    } finally {
      busy = startAll.disabled = false
    }
  })

  function planRow(path, plan) {
    const row = element('li')
    row.className = 'index-analysis'
    const details = element('details')
    const preview = element('ul')
    const shown = plan.assets.slice(0, 50)
    for (const asset of shown) preview.append(element('li', asset.sourcePath + ' · ' + assetStatus[asset.status]))
    details.append(element('summary', path.split(/[\\/]/).at(-1) + ' · ' + plan.total + ' записей'), preview)
    if (plan.total > shown.length) details.append(element('p', 'Показано ' + shown.length + ' из ' + plan.total + ' записей.'))
    const start = button('Обработать и добавить в индекс', async () => {
      if (busy) return
      start.disabled = true
      try {
        await queuePlan(path, plan, importOptions())
        await refresh()
      } catch (error) {
        showError(error)
        start.disabled = false
      }
    })
    row.append(details, start)
    queuedPlans.set(path, { plan, row, start })
    return row
  }

  async function inspect(paths) {
    if (busy) return
    busy = true
    status.textContent = 'Анализ пакетов…'
    plans.replaceChildren()
    queuedPlans.clear()
    startAll.hidden = true
    try {
      for (const path of [...new Set(paths)].filter(Boolean).slice(0, 16)) {
        try {
          const { package: plan } = await json(packagesRoute + '/inspect', post({ path }))
          plans.append(planRow(path, plan))
        } catch (error) {
          const name = path.split(/[\\/]/).at(-1)
          plans.append(element('li', name + ' · ' + error.message))
        }
      }
      status.textContent = paths.length > 16 ? 'За один раз можно проанализировать до 16 пакетов.' : ''
      startAll.hidden = queuedPlans.size < 2
    } finally {
      busy = false
    }
  }

  $('form').addEventListener('submit', event => {
    event.preventDefault()
    if (pathInput.value.trim()) void inspect([pathInput.value.trim()])
  })
  section.addEventListener('toggle', () => void refresh())
  dialog.addEventListener('close', () => clearTimeout(timer))
  if (bridge?.selectedFilePath) {
    const select = files => void inspect(Array.from(files, file => bridge.selectedFilePath(file)))
    $('drop').hidden = $('pick').hidden = false
    $('pick').addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', () => { select(fileInput.files); fileInput.value = '' })
    section.addEventListener('dragover', event => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault()
    })
    section.addEventListener('drop', event => {
      if (!event.dataTransfer.files.length) return
      event.preventDefault()
      select(event.dataTransfer.files)
    })
  }
  return { refresh }
}
