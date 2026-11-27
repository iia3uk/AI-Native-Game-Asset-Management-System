import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { IndexInputError } from './asset-index.mjs'
import { ScanChangeError } from './asset-files.mjs'

export class ScanWorker {
  #id = randomUUID()
  #stop = new AbortController()
  #task = null
  #timer

  constructor(index, onComplete = () => undefined, options = {}) {
    this.index = index
    this.onComplete = onComplete
    this.timeoutMs = options.timeoutMs ?? 300_000
    this.#timer = setInterval(() => this.wake(), options.pollMs ?? 500)
    this.#timer.unref()
    this.wake()
  }

  wake() {
    if (this.#task || this.#stop.signal.aborted) return
    this.#task = this.#work().catch(error => console.error('Index worker:', error.message))
      .finally(() => { this.#task = null })
  }

  async wait(id, signal = this.#stop.signal) {
    while (true) {
      signal.throwIfAborted()
      const job = this.index.jobs.get(id)
      if (!job || !['pending', 'running'].includes(job.status)) return job
      await delay(125, undefined, { signal })
    }
  }

  async stop() {
    clearInterval(this.#timer)
    this.#stop.abort()
    await this.#task
  }

  async #work() {
    while (!this.#stop.signal.aborted) {
      const job = this.index.jobs.claim(this.#id)
      if (!job) return
      await this.#scan(job)
    }
  }

  async #scan(job) {
    const cancel = new AbortController()
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = AbortSignal.any([this.#stop.signal, cancel.signal, timeout])
    let progress = 0
    const heartbeat = () => {
      try {
        const owner = this.index.jobs.heartbeat(job.id, this.#id, progress)
        if (!owner || owner.cancelled) cancel.abort()
      } catch (error) {
        cancel.abort(error)
      }
    }
    const timer = setInterval(heartbeat, 500)
    timer.unref()
    let outcome
    try {
      heartbeat()
      await this.index.scan(job.libraryId, {
        signal, onProgress: value => { progress = value }, beforeCommit: heartbeat,
        onCommit: result => this.index.jobs.finish(job.id, this.#id, { status: 'completed', progress, result }),
      })
    } catch (error) {
      const cancelled = this.index.jobs.get(job.id)?.cancelRequested
      if (cancelled) outcome = { status: 'cancelled', progress }
      else if (this.#stop.signal.aborted) outcome = { status: 'interrupted', progress, error: 'Worker stopped.' }
      else outcome = { status: 'failed', progress, error: timeout.aborted ? 'Истекло время сканирования.' : scanError(error) }
    } finally {
      clearInterval(timer)
    }
    const finished = outcome ? this.index.jobs.finish(job.id, this.#id, outcome) : this.index.jobs.get(job.id)
    if (finished?.status === 'completed') this.onComplete(job.libraryId)
  }
}

function scanError(error) {
  if (error instanceof IndexInputError || error instanceof ScanChangeError) return error.message
  if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) return 'Каталог или файл недоступен.'
  console.error('Scan failed:', error.message)
  return 'Ошибка сканирования библиотеки.'
}
