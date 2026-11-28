import { cleanupMessage } from './cleanup.js'

const route = '/api/index/folder-run'
const isActive = run => ['running', 'cleanup', 'reviewing'].includes(run?.phase)

function statusMessage(run) {
  if (run.phase === 'cancelled') return 'Обработка папки отменена. Исходники оставлены.'
  if (run.phase === 'failed') return run.error
  if (run.phase === 'done') return cleanupMessage(run.cleanup)
  if (run.phase === 'cleanup') return 'Проверка исходников и результатов импорта…'
  if (run.phase === 'reviewing') return 'Очистка была прервана. Проверьте оставшиеся исходники.'
  if (run.step === 'discover') return 'Анализ выбранной папки…'
  const action = run.status === 'pausing' ? 'Приостановка обработки папки' :
    run.status === 'paused' ? 'Обработка папки на паузе' :
      run.step === 'export' ? 'Экспорт результата' : run.step === 'scan' ? 'Индексация результата' : 'Обработка папки'
  return action + ' · ' + (run.position + 1) + ' из ' + run.total
}

export function mountFolderProcessing({ get, bridge, json, post, importOptions, refresh, openIndex, runLocked }) {
  if (!bridge?.cleanupFolderRun || !bridge.chooseFolder) return
  const section = get('source-cleanup')
  const source = get('process-source')
  const destination = get('process-destination')
  const shared = get('process-shared')
  const compact = get('process-compact')
  const sourcePick = get('process-source-pick')
  const destinationPick = get('process-destination-pick')
  const process = get('process-cleanup')
  const quick = get('process-folder-quick')
  const restore = get('restore-confirmation')
  const review = get('review-folder-cleanup')
  const leave = get('leave-folder-cleanup')
  const status = get('cleanup-status')
  const output = get('process-output')
  const controls = [source, destination, sourcePick, destinationPick, process, restore]
  const destinationOptions = [shared, compact]
  const setStatus = message => { status.textContent = message }
  let run
  let polling = false
  let busy = false
  let submitting = false
  let submission = 0
  let timer
  let lastUpdate
  section.hidden = quick.hidden = false

  function updateControls(next = run) {
    const active = isActive(next)
    quick.disabled = submitting
    quick.textContent = active ? 'Ход импорта UE / Unity' : 'Импорт UE / Unity…'
    for (const control of controls) control.disabled = active || submitting
    for (const option of destinationOptions) option.disabled = active || submitting || !destination.value.trim()
  }

  function display(next) {
    if (next && next.id !== run?.id) {
      source.value = next.source
      destination.value = next.destination ?? ''
      shared.checked = next.shared
      compact.checked = next.compact
    }
    if (isActive(next)) section.open = true
    updateControls(next)
    review.hidden = leave.hidden = busy || next?.phase !== 'reviewing'
    if (!next) return
    run = next
    const label = next.shared ? 'Библиотека' : 'Экспорт'
    output.textContent = next.exported > 1 ? (next.shared ? 'Библиотека · Пакетов: ' : 'Экспортировано пакетов · ') +
      next.exported + ' · ' + (next.storagePath ?? next.destination) :
      next.firstExport ? label + ' · ' + next.firstExport : ''
    const message = busy ? 'Проверка исходников и результатов импорта…' : statusMessage(next)
    const reused = next.reused ? ' · Использовано ' + (next.shared ? 'готовых импортов' : 'готовых экспортов') + ': ' + next.reused : ''
    setStatus(message + reused + (next.failureCount && next.phase !== 'failed'
      ? ' · Ошибок обработки ' + next.failureCount + ' · ' + next.firstFailure.path + ' · ' + next.firstFailure.error
      : ''))
    const update = [next.id, next.phase, next.position, next.step, next.status].join('/')
    if (update !== lastUpdate) {
      lastUpdate = update
      void refresh()
    }
  }

  async function cleanup(id, action) {
    if (busy) return
    busy = true
    display(run)
    try { return await bridge.cleanupFolderRun(id, action) }
    catch (error) { setStatus(error.message) }
    finally { busy = false }
  }

  async function poll() {
    if (polling) return
    clearTimeout(timer)
    polling = true
    try {
      if (submitting) {
        timer = setTimeout(poll, 1000)
        return
      }
      const currentSubmission = submission
      const { run: next } = await json(route)
      if (submitting || currentSubmission !== submission) {
        timer = setTimeout(poll, 1000)
        return
      }
      display(next)
      if (next?.phase === 'cleanup') {
        const result = await cleanup(next.id, 'offer')
        if (result?.status === 'failed') setStatus(cleanupMessage(result))
        timer = setTimeout(poll, 300)
      } else if (next?.phase === 'running' || busy) timer = setTimeout(poll, 1000)
      else if (next?.phase === 'reviewing') timer = setTimeout(poll, 3000)
    } catch (error) {
      setStatus(error.message)
      timer = setTimeout(poll, 3000)
    } finally { polling = false }
  }

  for (const [button, input] of [[sourcePick, source], [destinationPick, destination]]) {
    button.addEventListener('click', () => void runLocked(async () => {
      try {
        const folder = await bridge.chooseFolder()
        if (folder) {
          if (input === destination) shared.checked = true
          input.value = folder
          input.dispatchEvent(new Event('input'))
        }
      } catch (error) { setStatus(error.message) }
    }))
  }

  destination.addEventListener('input', () => {
    if (!isActive(run) && !submitting && destination.value.trim() && shared.disabled) shared.checked = true
    updateControls()
  })

  function showProgress() {
    section.open = true
    get('importer').open = true
    openIndex()
    section.querySelector('summary').focus()
  }

  function start(quickImport) {
    void runLocked(async () => {
      if (isActive(run)) {
        if (quickImport) showProgress()
        return
      }
      submitting = true
      submission++
      updateControls()
      let started
      try {
        const path = (!quickImport && source.value.trim()) || await bridge.chooseFolder()
        if (!path) return
        if (quickImport) showProgress()
        source.value = path
        output.textContent = ''
        setStatus('Запуск обработки папки…')
        const { mode, formats, editorVersion: unityVersion } = quickImport
          ? { mode: 'auto', formats: ['fbx', 'glb'] }
          : importOptions('unitypackage')
        const unrealVersion = quickImport ? undefined : importOptions('unreal-content').editorVersion
        const target = quickImport ? '' : destination.value.trim()
        const response = await json(route, post({ path, destination: target, compact: Boolean(target && compact.checked),
          shared: Boolean(target && shared.checked),
          mode, formats, unityVersion, unrealVersion }))
        started = response.run
      } catch (error) {
        if (quickImport) showProgress()
        setStatus(error.message)
      }
      finally {
        submitting = false
        if (started) { display(started); void poll() }
        else updateControls()
      }
    })
  }

  quick.addEventListener('click', () => start(true))
  get('process-folder-form').addEventListener('submit', event => {
    event.preventDefault()
    if (!process.disabled) start(false)
  })

  for (const [button, action] of [[review, 'review'], [leave, 'leave']]) {
    button.addEventListener('click', async () => {
      if (!run) return
      await cleanup(run.id, action)
      void poll()
    })
  }
  restore.addEventListener('click', () => void runLocked(async () => {
    try {
      const enabled = await bridge.restoreCleanupConfirmation()
      setStatus(enabled ? 'Подтверждения Unity и Unreal включены.' : 'Не удалось включить подтверждения.')
    } catch (error) { setStatus(error.message) }
  }))
  void poll()
}
