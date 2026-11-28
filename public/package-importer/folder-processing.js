import { requestPackageCleanup } from './cleanup.js'

const jobs = '/api/index/jobs/'
const packages = '/api/index/packages/'

async function waitForJob(id, json) {
  for (;;) {
    const { job } = await json(jobs + id)
    if (job.status !== 'pending' && job.status !== 'running') return job
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

async function runFolder({ path, destination, json, post, enqueue, refresh, setStatus, showExport }) {
  const inspect = target => json(packages + 'inspect', post(target)).then(response => response.package)
  const target = { path }
  let direct
  try {
    direct = await inspect(target)
  } catch (error) {
    if (!error.message.startsWith('Выберите проект Unity, папку UPM')) throw error
  }
  const report = direct ? null : await json(packages + 'folder', post(target))
  if (report?.truncated) throw new Error('Папка превышает лимит поиска. Выберите вложенную папку.')
  const targets = direct ? [target] : report.packages.map(({ path }) => ({ root: report.root, path }))
  if (!targets.length) throw new Error('В папке нет поддерживаемых пакетов Unity или Unreal.')
  const completed = []
  const failures = []
  try {
    for (const [index, target] of targets.entries()) {
      const counter = ' · ' + (index + 1) + ' из ' + targets.length
      setStatus('Обработка папки' + counter)
      try {
        const plan = direct ?? await inspect(target)
        const { job: queued } = await enqueue(target, plan)
        await refresh()
        const job = await waitForJob(queued.id, json)
        if (job.status === 'cancelled') return { completed: [], failures, cancelled: true }
        if (job.status !== 'completed') throw new Error(job.error || 'Импорт не завершён.')
        const scan = job.result?.scanJobId && await waitForJob(job.result.scanJobId, json)
        if (scan?.status === 'cancelled') return { completed: [], failures, cancelled: true }
        if (scan?.status !== 'completed') throw new Error(scan?.error || 'Индексация не завершена.')
        if (destination) {
          setStatus('Экспорт результата' + counter)
          const options = { destination, processedOnly: true }
          const { key } = await json(jobs + job.id + '/export-plan', post(options))
          const { directory } = await json(jobs + job.id + '/export', post({ ...options, key }))
          showExport(directory)
        }
        completed.push(job.id)
      } catch (error) {
        if (targets.length === 1) throw error
        failures.push({ path: target.path, message: error.message })
      }
    }
    return { completed, failures }
  } finally {
    await refresh()
  }
}

export function mountFolderProcessing({ get, bridge, json, post, enqueue, refresh, runLocked }) {
  if (!bridge?.cleanupSource || !bridge.chooseFolder) return
  const section = get('source-cleanup')
  const source = get('process-source')
  const destination = get('process-destination')
  const sourcePick = get('process-source-pick')
  const destinationPick = get('process-destination-pick')
  const process = get('process-cleanup')
  const restore = get('restore-confirmation')
  const status = get('cleanup-status')
  const output = get('process-output')
  const setStatus = message => { status.textContent = message }
  section.hidden = false

  for (const [button, input] of [[sourcePick, source], [destinationPick, destination]]) {
    button.addEventListener('click', () => void runLocked(async () => {
      try {
        const folder = await bridge.chooseFolder()
        if (folder) input.value = folder
      } catch (error) { setStatus(error.message) }
    }))
  }

  get('process-folder-form').addEventListener('submit', event => {
    event.preventDefault()
    void runLocked(async () => {
      const controls = [source, destination, sourcePick, destinationPick, process, restore]
      controls.forEach(control => { control.disabled = true })
      setStatus('')
      output.textContent = ''
      try {
        const path = source.value.trim() || await bridge.chooseFolder()
        if (!path) return
        source.value = path
        const folder = destination.value.trim()
        let exported = 0
        const showExport = directory => {
          exported++
          output.textContent = exported === 1 ? 'Экспорт · ' + directory :
            'Экспортировано пакетов · ' + exported + ' · ' + folder
        }
        setStatus('Анализ выбранной папки…')
        const { completed, failures, cancelled } = await runFolder({ path, destination: folder, json, post,
          enqueue, refresh, setStatus, showExport })
        if (cancelled) setStatus('Обработка папки отменена. Исходники оставлены.')
        else if (completed.length) await requestPackageCleanup(bridge, completed, status)
        else setStatus('Нет завершённых импортов для очистки.')
        if (failures.length) {
          const [{ path, message }] = failures
          status.textContent += ' · Ошибок обработки ' + failures.length + ' · ' + path + ' · ' + message
        }
      } catch (error) {
        setStatus(error.message)
      } finally {
        controls.forEach(control => { control.disabled = false })
      }
    })
  })

  restore.addEventListener('click', () => void runLocked(async () => {
    try {
      const enabled = await bridge.restoreCleanupConfirmation()
      setStatus(enabled ? 'Подтверждения Unity и Unreal включены.' : 'Не удалось включить подтверждения.')
    } catch (error) { setStatus(error.message) }
  }))
}
