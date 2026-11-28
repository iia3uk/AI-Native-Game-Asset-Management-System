import { setTimeout as delay } from 'node:timers/promises'
import { IndexConflictError, IndexInputError } from '../../index/index-errors.mjs'
import { isUnrealLoose } from '../unreal/loose/source.mjs'
import { inspectPackage, packageOptions } from '../dispatch.mjs'
import { exportPackageResult } from '../export/publish.mjs'
import { discoverFolderRun, folderRunSource } from './source.mjs'

function recipe(format, { mode, unityVersion, unrealVersion, formats }) {
  if (format === 'unreal-pak') return packageOptions(format, {})
  if (format === 'unityfs' || format === 'unity-serialized' || format === 'unreal-asset') {
    return packageOptions(format, { formats })
  }
  return packageOptions(format, { mode, formats, editorVersion: mode === 'engineless' ? '' :
    isUnrealLoose(format) ? unrealVersion : unityVersion })
}

function message(error) {
  if (error instanceof IndexInputError || error instanceof IndexConflictError) return error.message
  if (error.name === 'TimeoutError') return 'Истекло время анализа пакета или папки.'
  if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) return 'Каталог или файл недоступен.'
  console.error('Folder processing:', error.message)
  return 'Не удалось обработать папку.'
}

export class FolderRunWorker {
  #task

  constructor(index, { signal, importDirectory, protectedRoots, ignoredPaths, wakeImport, wakeScan }) {
    Object.assign(this, { index, signal, importDirectory, protectedRoots, ignoredPaths, wakeImport, wakeScan })
  }

  wake() {
    if (this.#task || this.signal.aborted) return
    const run = this.index.folderRuns.get()
    if (run?.phase !== 'running') return
    this.#task = this.#run(run).catch(error => {
      if (!this.signal.aborted) console.error('Folder processing:', error.message)
    }).finally(() => { this.#task = undefined })
  }

  async stop() { await this.#task }

  #timeout() { return AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]) }

  async #job(id, wake) {
    for (;;) {
      this.signal.throwIfAborted()
      const job = this.index.jobs.get(id)
      if (!job) return null
      if (job.status === 'interrupted' && this.index.jobs.retry(id)) wake()
      else if (!['pending', 'running', 'paused'].includes(job.status)) return job
      await delay(350, undefined, { signal: this.signal })
    }
  }

  async #process(run, item) {
    const { jobs, folderRuns } = this.index
    if (!item.jobId) {
      run.step = 'import'
      folderRuns.save(run)
      const source = await folderRunSource(run.source, item, this.ignoredPaths)
      const report = await inspectPackage(source, { signal: this.#timeout() })
      this.signal.throwIfAborted()
      const options = recipe(report.format, run.options)
      jobs.enqueueImport(source.path, report.hash, options.formats, options, job => {
        item.jobId = job.id
        folderRuns.save(run)
      })
      this.wakeImport()
    }
    const job = await this.#job(item.jobId, this.wakeImport)
    if (job?.status === 'cancelled') return 'cancelled'
    if (job?.status !== 'completed') throw new IndexConflictError(job?.error || 'Импорт не завершён.')
    if (run.step !== 'export') {
      run.step = 'scan'
      folderRuns.save(run)
    }
    const scan = await this.#job(job.result?.scanJobId ?? '', this.wakeScan)
    if (scan?.status === 'cancelled') return 'cancelled'
    if (scan?.status !== 'completed') throw new IndexConflictError(scan?.error || 'Индексация не завершена.')
    if (run.destination) {
      run.step = 'export'
      folderRuns.save(run)
      const result = await exportPackageResult(this.importDirectory,
        [...this.protectedRoots, run.source.path, ...this.index.libraries().map(library => library.root)], job,
        { destination: run.destination.path, processedOnly: true }, {
          signal: this.signal, jobSource: jobs.importSource(item.jobId), journal: {
            destination: run.destination, reservation: item.reservation, stage: item.stage,
            save: (kind, directory) => {
              item[kind] = directory
              folderRuns.save(run)
            },
          },
        })
      if (!result) throw new IndexConflictError('Результат импорта недоступен для экспорта.')
      item.directory = result.directory
    }
    item.complete = true
  }

  async #run(run) {
    const store = this.index.folderRuns
    try {
      if (run.step === 'discover') {
        run.items = await discoverFolderRun(run.source, this.ignoredPaths, this.#timeout())
        this.signal.throwIfAborted()
        run.step = 'import'
        store.save(run)
      }
      for (; run.position < run.items.length;) {
        this.signal.throwIfAborted()
        const item = run.items[run.position]
        try {
          const outcome = await this.#process(run, item)
          this.signal.throwIfAborted()
          if (outcome === 'cancelled') {
            store.save(run, 'cancelled')
            return
          }
        } catch (error) {
          this.signal.throwIfAborted()
          item.error = message(error)
        }
        run.position++
        run.step = 'import'
        store.save(run)
      }
      if (run.items.some(item => item.complete)) store.save(run, 'cleanup')
      else {
        run.error = run.items[0]?.error || 'Нет завершённых импортов для очистки.'
        store.save(run, 'failed')
      }
    } catch (error) {
      if (!this.signal.aborted) {
        run.error = message(error)
        store.save(run, 'failed')
      }
    }
  }
}
