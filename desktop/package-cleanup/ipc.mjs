import { realpath } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dialog, ipcMain, shell } from 'electron'
import { pathKey } from '../../core/files/asset-files.mjs'
import { planPackageCleanup, trashPackageSources } from '../../core/packages/cleanup/plan.mjs'
import { retireNativeCopies } from '../../core/packages/cleanup/retired.mjs'
import { exportPackageResult } from '../../core/packages/export/publish.mjs'
import { FolderRuns } from '../../core/packages/folder-processing/state.mjs'
import { ProcessingJobs } from '../../core/processing/processing-jobs.mjs'
import { cleanupPreferences, saveCleanupPreferences } from './preferences.mjs'

const validId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const engines = { unity: 'Unity', unreal: 'Unreal' }

function completedJobs(jobs, ids) {
  return ids.map(id => ({ job: jobs.get(id), source: jobs.importSource(id) })).filter(({ job }) =>
    job?.status === 'completed' && job.result?.scanJobId && jobs.get(job.result.scanJobId)?.status === 'completed')
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
      ...(plan.compact ? ['После переноса оригиналов Asset Viewer удалит их проверенные служебные копии. Готовые форматы останутся в библиотеке и в папке экспорта.'] : []),
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
  const protectedRoots = [paths.data, paths.cache, paths.config]
  ipcMain.handle('asset-viewer:cleanup-source', async (event, requested) => {
    const ids = Array.isArray(requested) ? requested : [requested]
    if (!trusted(event) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !validId.test(id))) {
      return { status: 'unavailable' }
    }
    if (busy) return { status: 'busy' }
    return locked(async () => {
      const db = new DatabaseSync(paths.database, { readOnly: true })
      let records
      try {
        db.exec('PRAGMA busy_timeout=4000')
        records = completedJobs(new ProcessingJobs(db), [...new Set(ids)])
      } finally { db.close() }
      return performCleanup(records, AbortSignal.timeout(10 * 60_000))
    })
  })

  ipcMain.handle('asset-viewer:cleanup-folder-run', async (event, id, action) => {
    if (!trusted(event) || typeof id !== 'string' || !validId.test(id) || !['offer', 'review', 'leave'].includes(action)) {
      return { status: 'unavailable' }
    }
    if (busy) return { status: 'busy' }
    return locked(async () => {
      const db = new DatabaseSync(paths.database)
      try {
        db.exec('PRAGMA busy_timeout=4000')
        const store = new FolderRuns(db)
        if (action === 'leave') return { status: store.dismissCleanup(id) ? 'cancelled' : 'unavailable' }
        const run = store.claimCleanup(id, action === 'review')
        if (!run) return { status: 'unavailable' }
        const jobs = new ProcessingJobs(db)
        const signal = AbortSignal.timeout(10 * 60_000)
        const items = new Map(run.items.filter(item => item.complete).map(item => [item.jobId, item]))
        const records = completedJobs(jobs, [...items.keys()])
        const skippedExports = new Set()
        const verifyPublished = async record => {
          const id = record.job.id
          const valid = await verifyExport(run, items.get(id), record, signal)
          if (!valid) skippedExports.add(id)
          return valid
        }
        const verified = []
        for (const record of records) {
          if (!run.destination || await verifyPublished(record)) verified.push(record)
        }
        const compact = run.destination && run.options?.compact === true ? verifyPublished : null
        const result = await performCleanup(verified, signal, {
          requireConfirmation: action === 'review', compact, jobs,
        })
        if (skippedExports.size) result.skippedExports = skippedExports.size
        store.save({ ...run, cleanup: result }, 'done')
        return result
      } finally { db.close() }
    })
  })

  async function verifyExport(run, item, { job, source }, signal) {
    if (!item?.directory || !item.reservation) return false
    try {
      const result = await exportPackageResult(paths.imports, [...protectedRoots, run.source.path], job,
        { destination: run.destination.path, processedOnly: true }, {
          signal, jobSource: source, journal: { destination: run.destination, reservation: item.reservation,
            exportJobId: item.exportJobId, verifyOnly: true },
        })
      return result?.directory === item.directory
    } catch (error) {
      signal.throwIfAborted()
      console.error('Folder export verification:', error.message)
      return false
    }
  }

  async function performCleanup(records, signal, { requireConfirmation, compact, jobs } = {}) {
    const store = await realpath(preferencesDirectory)
    const groups = { unity: new Map(), unreal: new Map() }
    const importsByOutput = new Map()
    for (const record of records) {
      const { job, source } = record
      const plan = await planPackageCleanup({ imports: paths.imports, protectedRoots, job, source, signal })
      if (!plan) continue
      if (compact) importsByOutput.set(plan.output, record)
      for (const file of plan.files) groups[plan.engine].set(pathKey(file.original.path), file)
    }
    const preferences = await cleanupPreferences(store)
    const result = { status: 'empty', moved: 0, skipped: 0, bytes: 0, preferenceSaved: true }
    let changedPreferences = false
    for (const [engine, group] of Object.entries(groups)) {
      if (!group.size) continue
      let files = [...group.values()]
      let optOut = false
      if (requireConfirmation || !preferences[engine]) {
        const answer = await confirmRemoval(window, { engine, files,
          compact: compact && files.some(file => file.nativeCopy),
          bytes: files.reduce((sum, file) => sum + file.original.info.size, 0) })
        if (answer.response !== 1) {
          if (result.status === 'empty') result.status = 'cancelled'
          continue
        }
        optOut = answer.checkboxChecked === true
      }
      if (compact) {
        const rejected = new Set()
        for (const output of new Set(files.filter(file => file.nativeCopy).map(file => file.output))) {
          if (!await compact(importsByOutput.get(output))) rejected.add(output)
        }
        files = files.filter(file => !file.nativeCopy || !rejected.has(file.output))
        if (!files.length) continue
      }
      const movedCopies = []
      const moved = await trashPackageSources({ files }, async path => {
        await shell.trashItem(path)
        if (compact) movedCopies.push(group.get(pathKey(path)))
      }, signal)
      result.status = 'completed'
      result.moved += moved.moved
      result.skipped += moved.skipped
      result.bytes += moved.bytes
      if (moved.moved && optOut) preferences[engine] = changedPreferences = true
      if (movedCopies.length) {
        const retirement = await retireNativeCopies(paths.imports, movedCopies, signal)
        for (const [key, value] of Object.entries(retirement)) result[key] = (result[key] ?? 0) + value
        if (retirement.retired) {
          for (const output of new Set(movedCopies.filter(file => file.nativeCopy).map(file => file.output))) {
            const libraryId = importsByOutput.get(output)?.job.libraryId
            if (libraryId) jobs.enqueue(libraryId)
          }
        }
      }
    }
    if (changedPreferences) {
      result.preferenceSaved = await saveCleanupPreferences(store, preferences)
        .then(() => true, () => false)
    }
    return result
  }

  async function locked(action) {
    busy = true
    try {
      return await action()
    } catch (error) {
      console.error('Package source cleanup:', error.message)
      return { status: 'failed' }
    } finally {
      busy = false
    }
  }

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
