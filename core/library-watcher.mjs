import { watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkedPath, identifyAsset, inside } from './asset-files.mjs'

export class LibraryWatcher {
  #roots = new Map()
  #timer
  #task
  #stopped = false
  #nextRefresh = 0

  constructor(index, onQueued, {
    debounceMs = 650, maxDebounceMs = 4000, refreshMs = 5000, reconcileMs = 15 * 60_000,
    pollMs = 250, ignoredPaths = [],
  } = {}) {
    this.index = index
    this.onQueued = onQueued
    this.debounceMs = debounceMs
    this.maxDebounceMs = maxDebounceMs
    this.refreshMs = refreshMs
    this.reconcileMs = reconcileMs
    this.ignoredPaths = ignoredPaths
    this.#timer = setInterval(() => this.#wake(), pollMs)
    this.#timer.unref()
    this.refresh()
  }

  refresh() {
    this.#nextRefresh = 0
    this.#wake()
  }

  async stop() {
    this.#stopped = true
    clearInterval(this.#timer)
    for (const state of this.#roots.values()) state.watcher?.close()
    await this.#task
    this.#roots.clear()
  }

  #wake() {
    if (this.#stopped || this.#task) return
    this.#task = this.#tick().catch(error => console.error('Library watcher:', error.message))
      .finally(() => { this.#task = undefined })
  }

  async #tick() {
    if (Date.now() >= this.#nextRefresh) {
      this.#nextRefresh = Date.now() + this.refreshMs
      await this.#refreshRoots()
    }
    if (this.#stopped) return
    const now = Date.now()
    for (const state of this.#roots.values()) {
      if (!state.identity || now < Math.min(state.due, state.reconcileAt)) continue
      const job = this.index.jobs.enqueue(state.id, { trigger: 'watch', priority: -10 })
      if (!job) {
        state.watcher?.close()
        this.#roots.delete(state.id)
      } else if (job.status === 'pending' && !job.cancelRequested) {
        state.due = Infinity
        state.firstEvent = null
        state.reconcileAt = now + this.reconcileMs
        this.onQueued()
      } else {
        // A scan may already have passed the affected path. Keep the event for a follow-up.
        state.due = now + this.debounceMs
        state.reconcileAt = Math.max(state.reconcileAt, state.due)
      }
    }
  }

  async #refreshRoots() {
    const libraries = this.index.watchedLibraries()
    const enabled = new Set(libraries.map(library => library.id))
    for (const [id, state] of this.#roots) {
      if (enabled.has(id)) continue
      state.watcher?.close()
      this.#roots.delete(id)
    }
    for (const { id, root } of libraries) {
      if (this.#stopped) return
      let state = this.#roots.get(id)
      if (!state) {
        state = { id, root, identity: null, watcher: null, firstEvent: null, due: Infinity, reconcileAt: Infinity }
        this.#roots.set(id, state)
      }
      const identity = await rootIdentity(root)
      if (this.#stopped) return
      if (identity !== state.identity) {
        state.watcher?.close()
        state.watcher = null
        state.identity = identity
        state.reconcileAt = identity ? Date.now() : Infinity
      }
      if (identity && !state.watcher) this.#attach(state)
    }
  }

  #attach(state) {
    try {
      const watcher = watch(state.root, { recursive: true, persistent: false }, (event, filename) => {
        if (this.#stopped || state.watcher !== watcher) return
        if (filename) {
          const target = resolve(state.root, filename)
          if (!inside(state.root, target) || this.ignoredPaths.some(path => inside(path, target))) return
          if (event === 'change' && !identifyAsset(filename)) return
        }
        this.#dirty(state)
      })
      state.watcher = watcher
      watcher.on('error', () => {
        if (state.watcher !== watcher) return
        watcher.close()
        state.watcher = null
        this.#dirty(state)
      })
    } catch {
      // Periodic reconciliation also works on filesystems without native recursive notifications.
    }
  }

  #dirty(state) {
    const now = Date.now()
    state.firstEvent ??= now
    state.due = Math.min(now + this.debounceMs, state.firstEvent + this.maxDebounceMs)
  }
}

async function rootIdentity(root) {
  if (!await checkedPath(root, root)) return null
  try {
    const info = await stat(root, { bigint: true })
    return info.isDirectory() ? `${info.dev}:${info.ino}` : null
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) return null
    throw error
  }
}
