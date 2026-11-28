import { sizeLabel } from '../catalog/format.js'

const jobs = '/api/index/jobs/'
const packages = '/api/index/packages/'
const active = job => job.status === 'pending' || job.status === 'running'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function requestPackageCleanup(bridge, ids, status) {
  status.textContent = 'Проверка исходников и результатов импорта…'
  try {
    const result = await bridge.cleanupSource(ids)
    switch (result.status) {
      case 'completed':
        status.textContent = 'В корзине · ' + result.moved + ' · ' + sizeLabel(result.bytes) +
          (result.skipped ? ' · Не удалось перенести ' + result.skipped : '') +
          (!result.preferenceSaved ? ' · Настройка подтверждения не сохранилась' : '')
        break
      case 'cancelled': status.textContent = 'Исходники оставлены.'; break
      case 'empty': status.textContent = 'Нет исходников с проверенными результатами для очистки.'; break
      case 'busy': status.textContent = 'Уже выполняется проверка исходников.'; break
      default: status.textContent = 'Не удалось проверить или перенести исходники.'
    }
  } catch (error) {
    status.textContent = error.message
  }
}

async function waitForJob(id, json) {
  for (;;) {
    const { job } = await json(jobs + id)
    if (!active(job)) return job
    await delay(1000)
  }
}

export async function importFolderForCleanup({ path, json, post, enqueue, refresh, setStatus }) {
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
  let failed = 0
  for (const [index, target] of targets.entries()) {
    setStatus('Обработка папки · ' + (index + 1) + ' из ' + targets.length)
    try {
      const plan = direct ?? await inspect(target)
      const { job: queued } = await enqueue(target, plan)
      await refresh()
      const job = await waitForJob(queued.id, json)
      if (job.status !== 'completed') {
        if (job.status === 'cancelled') return { completed: [], failed, cancelled: true }
        throw new Error(job.error || 'Импорт не завершён.')
      }
      if (job.result?.scanJobId && (await waitForJob(job.result.scanJobId, json)).status === 'completed') completed.push(job.id)
    } catch (error) {
      if (targets.length === 1) throw error
      failed++
    }
  }
  await refresh()
  return { completed, failed }
}
