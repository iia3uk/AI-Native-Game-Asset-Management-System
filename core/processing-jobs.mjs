import { randomUUID } from 'node:crypto'
import { transaction } from './index-schema.mjs'

const fields = 'id, library_id AS libraryId, type, status, priority, created_at AS createdAt, started_at AS startedAt,' +
  ' finished_at AS finishedAt, attempts, progress, result, error, cancel_requested AS cancelRequested'
const leaseMs = 15_000
const now = () => new Date().toISOString()
const shape = job => job && { ...job, result: job.result && JSON.parse(job.result), cancelRequested: Boolean(job.cancelRequested) }

export class ProcessingJobs {
  #db

  constructor(db) {
    this.#db = db
  }

  get(id) {
    return shape(this.#db.prepare('SELECT ' + fields + ' FROM processing_jobs WHERE id = ?').get(id))
  }

  list({ libraryId, limit = 50, offset = 0 } = {}) {
    const filter = libraryId ? 'WHERE library_id = ?' : ''
    const args = libraryId ? [libraryId] : []
    return this.#db.prepare(`SELECT ${fields} FROM processing_jobs ${filter}
      ORDER BY (status IN ('pending','running')) DESC, created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset).map(shape)
  }

  enqueue(libraryId, priority = 0) {
    return transaction(this.#db, () => {
      if (!this.#db.prepare('SELECT id FROM libraries WHERE id = ? AND enabled = 1').get(libraryId)) return null
      const current = this.#db.prepare(`SELECT id FROM processing_jobs WHERE library_id = ? AND type = 'scan'
        AND status IN ('pending','running')`).get(libraryId)
      if (current) return this.get(current.id)
      const id = randomUUID()
      this.#db.prepare(`INSERT INTO processing_jobs (id, library_id, type, status, priority, created_at)
        VALUES (?, ?, 'scan', 'pending', ?, ?)`).run(id, libraryId, priority, now())
      return this.get(id)
    })
  }

  cancel(id) {
    this.#db.prepare(`
      UPDATE processing_jobs SET cancel_requested = 1,
        status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
        finished_at = CASE WHEN status = 'pending' THEN ? ELSE finished_at END
      WHERE id = ? AND status IN ('pending','running')
    `).run(now(), id)
    return this.get(id)
  }

  retry(id) {
    return transaction(this.#db, () => {
      const job = this.get(id)
      if (!job || !['failed', 'interrupted', 'cancelled'].includes(job.status) || job.attempts >= 3) return null
      const library = this.#db.prepare('SELECT id FROM libraries WHERE id = ? AND enabled = 1').get(job.libraryId)
      const other = this.#db.prepare(`SELECT id FROM processing_jobs WHERE library_id = ? AND status IN ('pending','running')`).get(job.libraryId)
      if (!library || other) return null
      this.#db.prepare(`UPDATE processing_jobs SET status = 'pending', progress = 0, started_at = NULL,
        finished_at = NULL, result = NULL, error = NULL, cancel_requested = 0 WHERE id = ?`).run(id)
      return this.get(id)
    })
  }

  claim(worker) {
    const time = Date.now()
    const pending = this.#db.prepare("SELECT 1 FROM processing_jobs WHERE status = 'pending' OR (status = 'running' AND lease_until <= ?) LIMIT 1")
    if (!pending.get(time)) return null
    return transaction(this.#db, () => {
      this.#db.prepare(`UPDATE processing_jobs SET
        status = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'interrupted' END,
        error = CASE WHEN cancel_requested = 1 THEN NULL ELSE 'Worker stopped unexpectedly.' END,
        finished_at = ?, lease_until = NULL, worker = NULL
        WHERE status = 'running' AND lease_until <= ?`).run(now(), time)
      const job = this.#db.prepare("SELECT id FROM processing_jobs WHERE status = 'pending' ORDER BY priority DESC, created_at, rowid LIMIT 1").get()
      if (!job) return null
      this.#db.prepare(`UPDATE processing_jobs SET status = 'running', attempts = attempts + 1,
        started_at = ?, worker = ?, lease_until = ? WHERE id = ?`).run(now(), worker, time + leaseMs, job.id)
      return this.get(job.id)
    })
  }

  heartbeat(id, worker, progress) {
    return this.#db.prepare(`UPDATE processing_jobs SET progress = ?, lease_until = ?
      WHERE id = ? AND worker = ? AND status = 'running' RETURNING cancel_requested AS cancelled`)
      .get(progress, Date.now() + leaseMs, id, worker)
  }

  finish(id, worker, { status, progress, result = null, error = null }) {
    this.#db.prepare(`UPDATE processing_jobs SET status = ?, progress = ?, result = ?, error = ?,
      finished_at = ?, worker = NULL, lease_until = NULL WHERE id = ? AND worker = ? AND status = 'running'`)
      .run(status, progress, result && JSON.stringify(result), error, now(), id, worker)
    return this.get(id)
  }
}
