import { randomUUID } from 'node:crypto'
import { IndexConflictError } from '../../index/index-errors.mjs'

function read(row) {
  return row ? { ...JSON.parse(row.state), id: row.id, phase: row.phase } : null
}

export class FolderRuns {
  #db

  constructor(db) {
    this.#db = db
  }

  get() {
    return read(this.#db.prepare('SELECT id, phase, state FROM folder_run WHERE slot = 1').get())
  }

  start({ source, destination, options }) {
    const id = randomUUID()
    const state = JSON.stringify({ source, destination, options, step: 'discover', position: 0, items: [] })
    const row = this.#db.prepare(`INSERT INTO folder_run (slot, id, phase, state) VALUES (1, ?, 'running', ?)
      ON CONFLICT(slot) DO UPDATE SET id = excluded.id, phase = excluded.phase, state = excluded.state
      WHERE folder_run.phase IN ('done', 'cancelled', 'failed') RETURNING id, phase, state`).get(id, state)
    if (!row) throw new IndexConflictError('Сначала завершите текущую обработку папки.')
    return read(row)
  }

  save({ id, phase, ...state }, next = phase) {
    const result = this.#db.prepare('UPDATE folder_run SET phase = ?, state = ? WHERE id = ? AND phase = ?')
      .run(next, JSON.stringify(state), id, phase)
    if (!result.changes) throw new IndexConflictError('Задание обработки папки изменилось.')
  }

  claimCleanup(id, review) {
    return read(this.#db.prepare(`UPDATE folder_run SET phase = 'reviewing' WHERE id = ?
      AND (phase = 'cleanup' OR (phase = 'reviewing' AND ? = 1)) RETURNING id, phase, state`).get(id, Number(review)))
  }

  dismissCleanup(id) {
    return this.#db.prepare(`UPDATE folder_run SET phase = 'done',
      state = json_set(state, '$.cleanup', json('{"status":"cancelled"}'))
      WHERE id = ? AND phase = 'reviewing'`).run(id).changes > 0
  }
}

export function folderRunSummary(run, jobs) {
  if (!run) return null
  const { id, phase, step, source, destination, items, position, cleanup, error } = run
  const active = jobs.get(items[position]?.jobId ?? '')
  const failures = items.filter(item => item.error)
  const exports = items.filter(item => item.directory).map(item => item.directory)
  return { id, phase, step, source: source.path, destination: destination?.path, compact: run.options?.compact === true,
    shared: run.options?.shared === true, storagePath: run.storagePath,
    position, total: items.length,
    exported: exports.length, reused: items.filter(item => item.directory && (item.exportJobId || item.sharedReused)).length,
    firstExport: exports[0], failureCount: failures.length,
    firstFailure: failures[0] && { path: failures[0].path, error: failures[0].error },
    status: active?.pauseRequested && active.status === 'running' ? 'pausing' : active?.status,
    cleanup, error }
}
