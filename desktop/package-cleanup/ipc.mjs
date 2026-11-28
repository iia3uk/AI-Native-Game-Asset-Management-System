import { realpath } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dialog, ipcMain, shell } from 'electron'
import { pathKey } from '../../core/files/asset-files.mjs'
import { planPackageCleanup, trashPackageSources } from '../../core/packages/cleanup/plan.mjs'
import { ProcessingJobs } from '../../core/processing/processing-jobs.mjs'
import { cleanupPreferences, saveCleanupPreferences } from './preferences.mjs'

const validId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const engines = { unity: 'Unity', unreal: 'Unreal' }

function readJobs(database, ids) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const jobs = new ProcessingJobs(db)
    return ids.map(id => ({ job: jobs.get(id), source: jobs.importSource(id) })).filter(({ job }) =>
      job?.result?.scanJobId && jobs.get(job.result.scanJobId)?.status === 'completed')
  } finally {
    db.close()
  }
}

async function confirmRemoval(window, plan) {
  const items = plan.files.slice(0, 5).map(({ original }) => original.path)
  if (plan.files.length > items.length) items.push('и ещё ' + (plan.files.length - items.length))
  const size = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(plan.bytes / (1024 ** 2))
  return dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Очистка исходников ' + engines[plan.engine],
    message: 'Перенести обработанные исходники в корзину?',
    detail: [
      items.join('\n'), plan.files.length + ' файл(ов) · ' + size + ' МиБ',
      'Исходники могут содержать данные, которых нет в экспорте, и использоваться в проекте. В корзине их можно восстановить.',
    ].join('\n\n'),
    buttons: ['Оставить файлы', 'Перенести в корзину'], defaultId: 0, cancelId: 0, noLink: true,
    checkboxLabel: 'Больше не спрашивать для ' + engines[plan.engine],
    checkboxChecked: false,
  })
}

export function bindPackageCleanup({ window, origin, paths, preferencesDirectory }) {
  const trusted = event => event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url.startsWith(origin + '/')
  let busy = false
  ipcMain.handle('asset-viewer:cleanup-source', async (event, requested) => {
    const ids = Array.isArray(requested) ? requested : [requested]
    if (!trusted(event) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !validId.test(id))) {
      return { status: 'unavailable' }
    }
    if (busy) return { status: 'busy' }
    busy = true
    try {
      const signal = AbortSignal.timeout(10 * 60_000)
      const store = await realpath(preferencesDirectory)
      const groups = { unity: new Map(), unreal: new Map() }
      const protectedRoots = [paths.data, paths.cache, paths.config]
      for (const { job, source } of readJobs(paths.database, [...new Set(ids)])) {
        const plan = await planPackageCleanup({ imports: paths.imports, protectedRoots, job, source, signal })
        if (!plan) continue
        for (const file of plan.files) groups[plan.engine].set(pathKey(file.original.path), file)
      }
      const preferences = await cleanupPreferences(store)
      const result = { status: 'empty', moved: 0, skipped: 0, bytes: 0, preferenceSaved: true }
      let changedPreferences = false
      for (const [engine, group] of Object.entries(groups)) {
        if (!group.size) continue
        const files = [...group.values()]
        let optOut = false
        if (!preferences[engine]) {
          const answer = await confirmRemoval(window, { engine, files,
            bytes: files.reduce((sum, file) => sum + file.original.info.size, 0) })
          if (answer.response !== 1) {
            if (result.status === 'empty') result.status = 'cancelled'
            continue
          }
          optOut = answer.checkboxChecked === true
        }
        const moved = await trashPackageSources({ files }, path => shell.trashItem(path), signal)
        result.status = 'completed'
        result.moved += moved.moved
        result.skipped += moved.skipped
        result.bytes += moved.bytes
        if (moved.moved && optOut) preferences[engine] = changedPreferences = true
      }
      if (changedPreferences) {
        result.preferenceSaved = await saveCleanupPreferences(store, preferences)
          .then(() => true, () => false)
      }
      return result
    } catch (error) {
      console.error('Package source cleanup:', error.message)
      return { status: 'failed' }
    } finally {
      busy = false
    }
  })

  ipcMain.handle('asset-viewer:restore-cleanup-confirmation', async event => {
    if (!trusted(event) || busy) return false
    busy = true
    try {
      const store = await realpath(preferencesDirectory)
      await saveCleanupPreferences(store, { unity: false, unreal: false })
      return true
    } catch {
      return false
    } finally {
      busy = false
    }
  })
}
