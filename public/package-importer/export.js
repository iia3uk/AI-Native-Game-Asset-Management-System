import { sizeLabel } from '../catalog/format.js'

export function mountPackageExport({ record, json, post, chooseFolder, element, button }) {
  const panel = element('details')
  panel.className = 'package-export'
  const summary = element('summary', 'Экспортировать в папку')
  const selection = element('p', 'Весь пакет')
  const label = element('label', 'Папка назначения')
  const input = element('input')
  input.type = 'text'
  input.className = 'control'
  input.autocomplete = 'off'
  input.addEventListener('input', resetPlan)
  label.append(input)
  const controls = element('div')
  controls.className = 'index-toolbar'
  const whole = button('Выбрать весь пакет', () => select(undefined, 'Весь пакет'))
  whole.hidden = true
  const inspect = button('Составить план', () => void run(true))
  const save = button('Экспортировать', () => void run(false))
  save.hidden = true
  const status = element('p')
  status.setAttribute('role', 'status')
  const listing = element('details')
  listing.hidden = true
  const files = element('ul')
  listing.append(element('summary', 'Файлы в плане'), files)
  let asset
  let plan
  let busy = false
  const pick = chooseFolder && button('Выбрать папку', async () => {
    if (busy) return
    pick.disabled = true
    try {
      const folder = await chooseFolder()
      if (folder && !busy) {
        input.value = folder
        resetPlan()
      }
    } catch (error) {
      status.textContent = error.message
    } finally {
      pick.disabled = busy
    }
  })
  if (pick) controls.append(pick)
  controls.append(inspect, save, whole)
  panel.append(summary, selection, label, controls, status, listing)

  function resetPlan() {
    plan = undefined
    save.hidden = listing.hidden = true
    files.replaceChildren()
    status.textContent = ''
  }

  function select(ordinal, title) {
    if (busy) return
    asset = ordinal
    selection.textContent = title
    whole.hidden = ordinal === undefined
    panel.open = true
    resetPlan()
  }

  async function run(preview) {
    if (busy || !preview && !plan) return
    if (!input.value.trim()) {
      status.textContent = 'Укажите папку назначения.'
      input.focus()
      return
    }
    busy = input.disabled = inspect.disabled = save.disabled = whole.disabled = true
    if (pick) pick.disabled = true
    if (preview) resetPlan()
    status.textContent = preview ? 'Проверка файлов…' : 'Копирование файлов…'
    const route = '/api/index/jobs/' + record.id + (preview ? '/export-plan' : '/export')
    try {
      const result = await json(route, post({ destination: input.value.trim(), asset, key: plan?.key }))
      if (preview) {
        plan = result
        status.textContent = 'Файлов: ' + plan.files + ' · ' + sizeLabel(plan.bytes) + ' · ' + plan.destination +
          (plan.unresolved ? ' · Неразрешённых зависимостей: ' + plan.unresolved : '') +
          (['partial', 'unavailable'].includes(plan.dependencyStatus) ? ' · Сведения о зависимостях ограничены' : '')
        files.replaceChildren(...plan.paths.map(path => element('li', path)))
        if (plan.paths.length < plan.files) files.append(element('li', 'Всего файлов: ' + plan.files))
        save.hidden = listing.hidden = false
      } else {
        resetPlan()
        status.textContent = 'Экспорт завершён · ' + result.directory
      }
    } catch (error) {
      resetPlan()
      status.textContent = error.message
    } finally {
      busy = input.disabled = inspect.disabled = save.disabled = whole.disabled = false
      if (pick) pick.disabled = false
    }
  }

  return { panel, selectAsset(ordinal, title) {
    if (busy) return
    select(ordinal, title)
    input.focus()
  } }
}
