import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { IndexInputError } from './index-errors.mjs'
import { ScanChangeError } from './asset-files.mjs'
import { thumbnailCurrent } from './thumbnail-input.mjs'

export class ProcessingWorker {
  #id = randomUUID()
  #stop = new AbortController()
  #task = null
  #timer

  constructor(index, { type = 'scan', cache, targetId, onScanComplete,
    timeoutMs = type === 'scan' ? 300_000 : 25_000, pollMs = 500 } = {}) {
    this.index = index
    this.type = type
    this.cache = cache
    this.targetId = targetId
    this.onScanComplete = onScanComplete
    this.timeoutMs = timeoutMs
    this.#timer = setInterval(() => this.wake(), pollMs)
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
      const job = this.index.jobs.claim(this.#id, this.type, this.targetId)
      if (!job) return
      await this.#run(job)
    }
  }

  async #run(job) {
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
      signal.throwIfAborted()
      if (job.type === 'scan') {
        await this.index.scan(job.libraryId, {
          signal, onProgress: value => { progress = value }, beforeCommit: heartbeat,
          onCommit: result => this.index.jobs.finish(job.id, this.#id, { status: 'completed', progress, result }),
        })
      } else {
        await this.#thumbnail(job, signal, value => { progress = value; heartbeat(); signal.throwIfAborted() })
      }
    } catch (error) {
      const cancelled = this.index.jobs.get(job.id)?.cancelRequested
      if (cancelled) outcome = { status: 'cancelled', progress }
      else if (this.#stop.signal.aborted) outcome = { status: 'interrupted', progress, error: 'Worker stopped.' }
      else outcome = { status: 'failed', progress, error: processingError(job.type, error, timeout.aborted) }
    } finally {
      clearInterval(timer)
    }
    const finished = outcome ? this.index.jobs.finish(job.id, this.#id, outcome) : this.index.jobs.get(job.id)
    if (job.type === 'scan' && finished?.status === 'completed') this.onScanComplete?.(job.libraryId)
  }

  async #thumbnail(job, signal, advance) {
    const plan = this.index.thumbnailSource(job.assetId)
    if (plan?.key !== job.sourceKey || !await thumbnailCurrent(plan)) throw sourceChanged()
    advance(10)
    const publish = (cacheFile = () => {}) => {
      signal.throwIfAborted()
      this.index.jobs.completeThumbnail(job.id, this.#id, () => {
        const source = this.index.thumbnailSource(job.assetId)
        if (source?.key !== plan.key) throw sourceChanged()
        cacheFile()
      })
    }
    if (await this.cache.get(plan.key)) return publish()
    const image = await generateThumbnail(plan, signal)
    const current = this.index.thumbnailSource(job.assetId)
    if (current?.key !== plan.key || !await thumbnailCurrent(current)) throw sourceChanged()
    advance(85)
    await this.cache.put(plan.key, image, signal, publish)
  }
}

const sourceChanged = () => new IndexInputError('Исходный файл или буфер изменился. Обновите индекс.')

function processingError(type, error, timedOut) {
  if (timedOut) return type === 'scan' ? 'Истекло время сканирования.' : 'Истекло время создания миниатюры.'
  if (error instanceof IndexInputError || error instanceof ScanChangeError) return error.message
  if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) return 'Каталог или файл недоступен.'
  console.error(type + ' failed:', error.message)
  return type === 'scan' ? 'Ошибка сканирования библиотеки.' : 'Не удалось создать миниатюру.'
}

async function generateThumbnail(plan, signal) {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./thumbnail-render.mjs', import.meta.url), {
    workerData: plan, resourceLimits: { maxOldGenerationSizeMb: 196, stackSizeMb: 4 },
  })
  let abort
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('Thumbnail renderer exited without an image.')))
      worker.once('message', message => {
        if (message.error) reject(new IndexInputError(message.error))
        else resolve(message.image)
      })
    })
  } finally {
    signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
