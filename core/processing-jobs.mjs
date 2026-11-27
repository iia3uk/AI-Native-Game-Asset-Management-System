import { randomUUID } from 'node:crypto'
import { transaction } from './index-schema.mjs'
import { IndexInputError } from './index-errors.mjs'

const fields = 'id, library_id AS libraryId, type, status, priority, created_at AS createdAt, started_at AS startedAt,' +
  ' finished_at AS finishedAt, attempts, progress, result, error, trigger, cancel_requested AS cancelRequested,' +
  ' asset_id AS assetId, source_key AS sourceKey'
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

  list({ libraryId, type, limit = 50, offset = 0 } = {}) {
    const conditions = []
    const args = []
    if (libraryId) {
      conditions.push('library_id = ?')
      args.push(libraryId)
    }
    if (type) {
      conditions.push('type = ?')
      args.push(type)
    }
    const filter = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
    return this.#db.prepare(`SELECT ${fields} FROM processing_jobs ${filter}
      ORDER BY (status IN ('pending','running')) DESC, created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset).map(shape)
  }

  enqueue(libraryId, { priority = 0, trigger = 'manual' } = {}) {
    return transaction(this.#db, () => {
      const library = this.#db.prepare('SELECT watch_enabled FROM libraries WHERE id = ? AND enabled = 1').get(libraryId)
      if (!library || (trigger === 'watch' && !library.watch_enabled)) return null
      const current = this.#db.prepare(`SELECT id, trigger, cancel_requested FROM processing_jobs WHERE library_id = ? AND type = 'scan'
        AND status IN ('pending','running')`).get(libraryId)
      if (current) {
        if (trigger === 'manual' && current.trigger === 'watch' && !current.cancel_requested) {
          this.#db.prepare("UPDATE processing_jobs SET trigger = 'manual', priority = MAX(priority, ?) WHERE id = ?")
            .run(priority, current.id)
        }
        return this.get(current.id)
      }
      const id = randomUUID()
      this.#db.prepare(`INSERT INTO processing_jobs (id, library_id, type, status, priority, created_at, trigger)
        VALUES (?, ?, 'scan', 'pending', ?, ?, ?)`).run(id, libraryId, priority, now(), trigger)
      return this.get(id)
    })
  }

  latestThumbnail(assetId, sourceKey) {
    return shape(this.#db.prepare(`SELECT ${fields} FROM processing_jobs
      WHERE type = 'thumbnail' AND asset_id = ? AND source_key = ? ORDER BY rowid DESC LIMIT 1`).get(assetId, sourceKey))
  }

  enqueueThumbnail({ id: assetId, libraryId, key }) {
    return transaction(this.#db, () => {
      const asset = this.#db.prepare(`SELECT 1 FROM assets a JOIN libraries l ON a.library_id = l.id
        WHERE a.id = ? AND l.id = ? AND l.enabled = 1 AND a.missing_since IS NULL`).get(assetId, libraryId)
      if (!asset) return null
      const current = this.#db.prepare(`SELECT id FROM processing_jobs WHERE type = 'thumbnail' AND asset_id = ?
        AND source_key = ? AND status IN ('pending','running')`).get(assetId, key)
      if (current) return this.get(current.id)
      const id = randomUUID()
      this.#db.prepare(`INSERT INTO processing_jobs (id, library_id, type, status, priority, created_at, asset_id, source_key)
        VALUES (?, ?, 'thumbnail', 'pending', 0, ?, ?, ?)`).run(id, libraryId, now(), assetId, key)
      return this.get(id)
    })
  }

  cancelWatch(libraryId) {
    this.#cancelWhere("library_id = ? AND trigger = 'watch'", libraryId)
  }

  cancelThumbnails(libraryId) {
    this.#cancelWhere("library_id = ? AND type = 'thumbnail'", libraryId)
  }

  cancel(id) {
    this.#cancelWhere('id = ?', id)
    return this.get(id)
  }

  #cancelWhere(condition, argument) {
    this.#db.prepare(`
      UPDATE processing_jobs SET cancel_requested = 1,
        status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
        finished_at = CASE WHEN status = 'pending' THEN ? ELSE finished_at END
      WHERE (${condition}) AND status IN ('pending','running')
    `).run(now(), argument)
  }

  retry(id) {
    return transaction(this.#db, () => {
      const job = this.get(id)
      if (!job || !['failed', 'interrupted', 'cancelled'].includes(job.status) || job.attempts >= 3) return null
      const library = this.#db.prepare('SELECT id FROM libraries WHERE id = ? AND enabled = 1').get(job.libraryId)
      const other = job.type === 'scan' ? this.#db.prepare(`SELECT id FROM processing_jobs
        WHERE type = 'scan' AND library_id = ? AND status IN ('pending','running')`).get(job.libraryId)
        : this.#db.prepare(`SELECT id FROM processing_jobs WHERE type = 'thumbnail' AND asset_id = ?
          AND source_key = ? AND status IN ('pending','running')`).get(job.assetId, job.sourceKey)
      if (!library || other) return null
      this.#db.prepare(`UPDATE processing_jobs SET status = 'pending', progress = 0, started_at = NULL,
        finished_at = NULL, result = NULL, error = NULL, cancel_requested = 0, trigger = 'manual', priority = MAX(priority, 0)
        WHERE id = ?`).run(id)
      return this.get(id)
    })
  }

  claim(worker, type = 'scan', targetId = null) {
    const time = Date.now()
    const pending = this.#db.prepare(`SELECT 1 FROM processing_jobs
      WHERE type = ? AND (status = 'pending' OR (status = 'running' AND lease_until <= ?)) LIMIT 1`)
    if (!pending.get(type, time)) return null
    return transaction(this.#db, () => {
      this.#db.prepare(`UPDATE processing_jobs SET
        status = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'interrupted' END,
        error = CASE WHEN cancel_requested = 1 THEN NULL ELSE 'Worker stopped unexpectedly.' END,
        finished_at = ?, lease_until = NULL, worker = NULL
        WHERE type = ? AND status = 'running' AND lease_until <= ?`).run(now(), type, time)
      if (type === 'thumbnail' && this.#db.prepare("SELECT 1 FROM processing_jobs WHERE type = ? AND status = 'running'").get(type)) return null
      const job = this.#db.prepare(`SELECT id FROM processing_jobs WHERE type = ? AND status = 'pending'
        AND (? IS NULL OR id = ?) ORDER BY priority DESC, created_at, rowid LIMIT 1`).get(type, targetId, targetId)
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

  completeThumbnail(id, worker, publish = () => {}) {
    return transaction(this.#db, () => {
      const owner = this.#db.prepare(`SELECT 1 FROM processing_jobs WHERE id = ? AND worker = ? AND type = 'thumbnail'
        AND status = 'running' AND cancel_requested = 0 AND lease_until > ?`).get(id, worker, Date.now())
      if (!owner) throw new IndexInputError('Публикация миниатюры отменена.')
      publish()
      return this.finish(id, worker, { status: 'completed', progress: 100, result: { format: 'png' } })
    })
  }
}
