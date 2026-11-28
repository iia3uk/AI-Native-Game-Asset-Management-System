import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { transaction } from '../index/index-schema.mjs'
import { IndexInputError } from '../index/index-errors.mjs'
import { queueWatchedPackages } from './package-watch.mjs'

const fields = 'id, library_id AS libraryId, type, status, priority, created_at AS createdAt, started_at AS startedAt,' +
  ' finished_at AS finishedAt, attempts, progress, result, error, trigger, cancel_requested AS cancelRequested,' +
  ' asset_id AS assetId, source_key AS sourceKey, package_path AS packagePath, export_formats AS exportFormats,' +
  ' engine_mode AS engineMode, editor_version AS editorVersion, pause_requested AS pauseRequested'
const leaseMs = 15_000
const importLimit = 16
const now = () => new Date().toISOString()
const parking = 'pause_requested = 1 AND cancel_requested = 0'
const releasingLease = `
  status = CASE WHEN ${parking} THEN 'pending' WHEN cancel_requested = 1 THEN 'cancelled' ELSE ? END,
  progress = CASE WHEN ${parking} THEN 0 ELSE COALESCE(?, progress) END,
  attempts = attempts - (${parking}),
  result = CASE WHEN pause_requested = 1 OR cancel_requested = 1 THEN NULL ELSE ? END,
  error = CASE WHEN pause_requested = 1 OR cancel_requested = 1 THEN NULL ELSE ? END,
  started_at = CASE WHEN ${parking} THEN NULL ELSE started_at END,
  finished_at = CASE WHEN ${parking} THEN NULL ELSE ? END,
  worker = NULL, lease_until = NULL`

function shape(job) {
  if (!job) return job
  const { packagePath, exportFormats, engineMode, editorVersion, pauseRequested, ...fields } = job
  if (packagePath) {
    fields.packageName = basename(packagePath)
    if (exportFormats) fields.exportFormats = exportFormats.split(',')
    if (engineMode !== 'engineless') fields.engineMode = engineMode
    if (editorVersion) fields.editorVersion = editorVersion
    if (pauseRequested) {
      fields.pauseRequested = true
      if (fields.status === 'pending') fields.status = 'paused'
    }
  }
  return { ...fields, result: job.result && JSON.parse(job.result), cancelRequested: Boolean(job.cancelRequested) }
}

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
      ORDER BY (status IN ('pending','running')) DESC, pause_requested ASC, created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset).map(shape)
  }

  enqueue(libraryId, { priority = 0, trigger = 'manual' } = {}) {
    return transaction(this.#db, () => this.#enqueueScan(libraryId, priority, trigger))
  }

  #enqueueScan(libraryId, priority, trigger) {
    const library = this.#db.prepare(`SELECT watch_enabled OR EXISTS (
      SELECT 1 FROM package_watch_libraries WHERE library_id = libraries.id
    ) AS watching FROM libraries WHERE id = ? AND enabled = 1`).get(libraryId)
    if (!library || (trigger === 'watch' && !library.watching)) return null
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
  }

  #activeImport(path, key, exportFormats, mode, editorVersion) {
    return this.#db.prepare(`SELECT id FROM processing_jobs WHERE type = 'package-import' AND package_path = ?
      AND source_key = ? AND export_formats = ? AND engine_mode = ? AND editor_version = ?
      AND status IN ('pending','running')`).get(path, key, exportFormats, mode, editorVersion)
  }

  #importCount() {
    return this.#db.prepare(`SELECT COUNT(*) AS count FROM processing_jobs
      WHERE type = 'package-import' AND status IN ('pending','running')`).get().count
  }

  #createImport(path, key, formats, mode, editorVersion, priority, trigger) {
    const id = randomUUID()
    this.#db.prepare(`INSERT INTO processing_jobs (id, type, status, priority, created_at, source_key, package_path,
      export_formats, engine_mode, editor_version, trigger) VALUES (?, 'package-import', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, priority, now(), key, path, formats, mode, editorVersion, trigger)
    return this.get(id)
  }

  enqueueImport(path, key, exportFormats = '', { mode = 'engineless', editorVersion = '' } = {}) {
    return transaction(this.#db, () => {
      const current = this.#activeImport(path, key, exportFormats, mode, editorVersion)
      if (current) {
        this.#db.prepare("UPDATE processing_jobs SET trigger = 'manual', priority = MAX(priority, 0) WHERE id = ? AND cancel_requested = 0")
          .run(current.id)
        return this.get(current.id)
      }
      if (this.#importCount() >= importLimit) throw new IndexInputError('Очередь импорта заполнена.')
      return this.#createImport(path, key, exportFormats, mode, editorVersion, 0, 'manual')
    })
  }

  refillWatchedImports(ignoredPaths) {
    const mode = 'engineless'
    return transaction(this.#db, () => queueWatchedPackages(this.#db, importLimit - 1 - this.#importCount(), ignoredPaths, (path, key, formats) => {
      if (this.#activeImport(path, key, formats, mode, '')) return null
      return this.#createImport(path, key, formats, mode, '', -10, 'watch')
    }))
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

  cancelPackageWatch(libraryId, format = null) {
    this.#cancelWhere(`trigger = 'watch' AND id IN (SELECT job_id FROM package_watch_imports
      WHERE library_id = ? AND (? IS NULL OR format = ?))`, libraryId, format, format)
  }

  cancelThumbnails(libraryId) {
    this.#cancelWhere("library_id = ? AND type = 'thumbnail'", libraryId)
  }

  cancel(id) {
    this.#cancelWhere('id = ?', id)
    return this.get(id)
  }

  pauseImport(id) {
    const job = this.#db.prepare(`UPDATE processing_jobs SET pause_requested = 1
      WHERE id = ? AND type = 'package-import' AND status IN ('pending','running') AND cancel_requested = 0
      RETURNING ${fields}`).get(id)
    return shape(job)
  }

  resumeImport(id) {
    const job = this.#db.prepare(`UPDATE processing_jobs SET pause_requested = 0
      WHERE id = ? AND type = 'package-import' AND status = 'pending' AND ${parking}
      RETURNING ${fields}`).get(id)
    return shape(job)
  }

  #cancelWhere(condition, ...args) {
    this.#db.prepare(`
      UPDATE processing_jobs SET cancel_requested = 1, pause_requested = 0,
        status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
        finished_at = CASE WHEN status = 'pending' THEN ? ELSE finished_at END
      WHERE (${condition}) AND status IN ('pending','running')
    `).run(now(), ...args)
  }

  retry(id) {
    return transaction(this.#db, () => {
      const job = this.get(id)
      if (!job || !['failed', 'interrupted', 'cancelled'].includes(job.status) || job.attempts >= 3) return null
      if (job.type === 'package-import') {
        if (this.#activeImport(this.importSource(job.id), job.sourceKey, job.exportFormats?.join(',') ?? '',
          job.engineMode ?? 'engineless', job.editorVersion ?? '')) return null
        if (this.#importCount() >= importLimit) throw new IndexInputError('Очередь импорта заполнена.')
      } else {
        const library = this.#db.prepare('SELECT id FROM libraries WHERE id = ? AND enabled = 1').get(job.libraryId)
        const other = job.type === 'scan' ? this.#db.prepare(`SELECT id FROM processing_jobs
          WHERE type = 'scan' AND library_id = ? AND status IN ('pending','running')`).get(job.libraryId)
          : this.#db.prepare(`SELECT id FROM processing_jobs WHERE type = 'thumbnail' AND asset_id = ?
            AND source_key = ? AND status IN ('pending','running')`).get(job.assetId, job.sourceKey)
        if (!library || other) return null
      }
      this.#db.prepare(`UPDATE processing_jobs SET status = 'pending', progress = 0, started_at = NULL,
        finished_at = NULL, result = NULL, error = NULL, cancel_requested = 0, trigger = 'manual', priority = MAX(priority, 0)
        WHERE id = ?`).run(id)
      return this.get(id)
    })
  }

  claim(worker, type = 'scan', targetId = null) {
    const time = Date.now()
    const pending = this.#db.prepare(`SELECT 1 FROM processing_jobs
      WHERE type = ? AND ((status = 'pending' AND pause_requested = 0) OR
        (status = 'running' AND lease_until <= ?)) LIMIT 1`)
    if (!pending.get(type, time)) return null
    return transaction(this.#db, () => {
      this.#db.prepare(`UPDATE processing_jobs SET ${releasingLease}
        WHERE type = ? AND status = 'running' AND lease_until <= ?`)
        .run('interrupted', null, null, 'Worker stopped unexpectedly.', now(), type, time)
      if (type !== 'scan' && this.#db.prepare("SELECT 1 FROM processing_jobs WHERE type = ? AND status = 'running'").get(type)) return null
      const job = this.#db.prepare(`SELECT id FROM processing_jobs WHERE type = ? AND status = 'pending' AND pause_requested = 0
        AND (? IS NULL OR id = ?) ORDER BY priority DESC, created_at, rowid LIMIT 1`).get(type, targetId, targetId)
      if (!job) return null
      this.#db.prepare(`UPDATE processing_jobs SET status = 'running', attempts = attempts + 1,
        started_at = ?, worker = ?, lease_until = ? WHERE id = ?`).run(now(), worker, time + leaseMs, job.id)
      return this.get(job.id)
    })
  }

  heartbeat(id, worker, progress) {
    return this.#db.prepare(`UPDATE processing_jobs SET progress = ?, lease_until = ?
      WHERE id = ? AND worker = ? AND status = 'running'
      RETURNING cancel_requested AS cancelled, pause_requested AS paused`)
      .get(progress, Date.now() + leaseMs, id, worker)
  }

  finish(id, worker, { status, progress, result = null, error = null }) {
    this.#db.prepare(`UPDATE processing_jobs SET ${releasingLease}
      WHERE id = ? AND worker = ? AND status = 'running'`)
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

  importSource(id) {
    return this.#db.prepare("SELECT package_path FROM processing_jobs WHERE id = ? AND type = 'package-import'").get(id)?.package_path
  }

  watchedImportSource(id) {
    return this.#db.prepare(`SELECT l.root, l.enabled, w.source_path AS path, w.format
      FROM package_watch_imports w JOIN libraries l ON l.id = w.library_id WHERE w.job_id = ?`).get(id)
  }

  completeImport(id, worker, publish) {
    return transaction(this.#db, () => {
      const owner = this.#db.prepare(`SELECT 1 FROM processing_jobs WHERE id = ? AND worker = ? AND type = 'package-import'
        AND status = 'running' AND cancel_requested = 0 AND pause_requested = 0 AND lease_until > ?`).get(id, worker, Date.now())
      if (!owner) throw new IndexInputError('Публикация пакета отменена.')
      const result = publish()
      let scanJobId = null
      if (result.library) {
        const { id: libraryId } = result.library
        scanJobId = this.#enqueueScan(libraryId, 0, 'manual').id
        this.#db.prepare('UPDATE processing_jobs SET library_id = ? WHERE id = ?').run(libraryId, id)
      }
      return this.finish(id, worker, { status: 'completed', progress: 100, result: { ...result, scanJobId } })
    })
  }
}
