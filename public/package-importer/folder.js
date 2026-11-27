import { formatLabel } from './formats.js'

export function mountPackageFolder({ $, scan, inspect, chooseFolder, batchSize }) {
  const get = id => $('folder-' + id)
  const input = get('path')
  const pick = get('pick')
  const search = get('search')
  const status = get('status')
  const list = get('results')
  const controls = get('controls')
  const previous = get('prev')
  const next = get('next')
  const analyze = get('inspect')
  let report
  let offset = 0
  let busy = false

  function updateSelection() {
    analyze.disabled = busy || !list.querySelector('input:checked')
  }

  function render() {
    const packages = report?.packages ?? []
    list.replaceChildren()
    for (const { path, format } of packages.slice(offset, offset + batchSize)) {
      const row = document.createElement('li')
      const label = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.value = path
      checkbox.checked = true
      label.append(checkbox, ' ' + path + ' · ' + formatLabel(format))
      row.append(label)
      list.append(row)
    }
    controls.hidden = !packages.length
    previous.disabled = offset === 0
    next.disabled = offset + batchSize >= packages.length
    get('page').textContent = packages.length ?
      `${offset + 1}–${Math.min(offset + batchSize, packages.length)} из ${packages.length}` : ''
    updateSelection()
  }

  async function find(path) {
    if (busy) return
    busy = search.disabled = pick.disabled = true
    report = null
    offset = 0
    render()
    status.textContent = 'Поиск пакетов во вложенных папках…'
    try {
      report = await scan(path)
      status.textContent = 'Найдено файлов: ' + report.packages.length + '.' +
        (report.truncated ? ' Достигнут лимит поиска. Для продолжения выберите вложенную папку.' : '') +
        (report.skipped ? ' Недоступных файлов и папок: ' + report.skipped + '.' : '')
    } catch (error) {
      status.textContent = error.message
    } finally {
      busy = search.disabled = pick.disabled = false
      render()
    }
  }

  get('form').addEventListener('submit', event => {
    event.preventDefault()
    if (input.value.trim()) void find(input.value.trim())
  })
  if (chooseFolder) {
    pick.hidden = false
    pick.addEventListener('click', async () => {
      pick.disabled = true
      try {
        const path = await chooseFolder()
        if (path && !busy) {
          input.value = path
          await find(path)
        }
      } catch (error) {
        status.textContent = error.message
      } finally {
        pick.disabled = busy
      }
    })
  }
  previous.addEventListener('click', () => { offset -= batchSize; render() })
  next.addEventListener('click', () => { offset += batchSize; render() })
  list.addEventListener('change', updateSelection)
  analyze.addEventListener('click', () => {
    const targets = Array.from(list.querySelectorAll('input:checked'), input => ({ root: report.root, path: input.value }))
    void inspect(targets)
  })
}
