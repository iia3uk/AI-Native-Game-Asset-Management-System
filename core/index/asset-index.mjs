import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { checkedPath, discoverAssets, folderPath, identifyAsset, inside, pathKey } from '../files/asset-files.mjs'
import { hashFile } from '../files/hash.mjs'
import { analysisVersion, analyzeAsset, dependencyLimit, supportsAnalysis } from '../analysis/asset-analysis.mjs'
import { migrate, schemaVersion, transaction } from './index-schema.mjs'
import { IndexInputError } from './index-errors.mjs'
import { ProcessingJobs } from '../processing/processing-jobs.mjs'
import { QualityProfiles, validateQuality } from '../analysis/quality-profiles.mjs'
import { thumbnailPlan } from '../thumbnails/thumbnail-input.mjs'
import { maxPakInput } from '../packages/unreal/pak/limits.mjs'
import { watchedFormatByExtension, watchedPackageRecipe } from '../packages/watch-formats.mjs'
import { watchSerializedSource } from '../packages/unity/bundle/watch-source.mjs'
import { FolderRuns } from '../packages/folder-processing/state.mjs'

const readable = 'a.id, a.library_id AS libraryId, l.name AS library, a.path, a.name, a.ext, a.kind,' +
  ' a.size, a.mtime, a.hash, a.first_seen AS firstSeen, a.missing_since AS missingSince,' +
  ' a.category, a.tags, a.note, a.review, a.license'
const kinds = new Set(['model', 'image', 'other'])
const reviews = new Set(['', 'candidate', 'later', 'excluded'])
const libraryIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/
const maxHashedSize = 1024 ** 3
const timestamp = () => new Date().toISOString()
const folded = value => value.normalize('NFKC').toLowerCase()
const content = (path, metadata = {}) =>
  folded([path, metadata.category, ...JSON.parse(metadata.tags ?? '[]'), metadata.note, metadata.license].join('\n'))
const shape = asset => asset && { ...asset, tags: JSON.parse(asset.tags) }

export { IndexInputError } from './index-errors.mjs'

function countHashes(files) {
  const counts = new Map()
  for (const { hash } of files) if (hash) counts.set(hash, (counts.get(hash) ?? 0) + 1)
  return counts
}

function stringField(value, max) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new IndexInputError('Некорректное текстовое поле.')
  }
  return value.trim()
}

function validateId(id) {
  if (typeof id !== 'string' || !libraryIdPattern.test(id)) throw new IndexInputError('Некорректный идентификатор.')
}

function allowedLibraries(condition, args, libraryIds) {
  if (libraryIds === undefined) return
  if (!Array.isArray(libraryIds) || libraryIds.length > 100) throw new IndexInputError('Некорректный список библиотек.')
  for (const id of libraryIds) validateId(id)
  condition.push(libraryIds.length ? 'a.library_id IN (' + libraryIds.map(() => '?').join(', ') + ')' : '0')
  args.push(...libraryIds)
}

export class AssetIndex {
  #db
  #scans = new Map()

  static async open(path) {
    if (path !== ':memory:') await mkdir(dirname(path), { recursive: true })
    return new AssetIndex(path)
  }

  constructor(path, { readOnly = false } = {}) {
    this.#db = new DatabaseSync(path, { readOnly })
    try {
      this.#db.exec('PRAGMA busy_timeout=4000; PRAGMA foreign_keys=ON;')
      if (readOnly) {
        if (this.#db.prepare('PRAGMA user_version').get().user_version !== schemaVersion) {
          throw new Error('The asset index schema does not match this application.')
        }
      } else {
        this.#db.exec('PRAGMA journal_mode=WAL;')
        migrate(this.#db)
      }
      this.jobs = new ProcessingJobs(this.#db)
      this.folderRuns = new FolderRuns(this.#db)
      this.qualityProfiles = new QualityProfiles(this.#db)
    } catch (error) {
      this.#db.close()
      throw error
    }
  }

  async close() {
    await Promise.allSettled(this.#scans.values())
    this.#db.close()
  }

  async connect(path) {
    const root = await folderPath(path).catch(() => { throw new IndexInputError('Папка не найдена или недоступна.') })
    return this.registerLibrary(root, basename(root) || root)
  }

  // Used inside the package publication transaction, after committing its verified root to disk.
  registerLibrary(root, name) {
    this.#db.prepare(`
      INSERT INTO libraries (id, root, root_key, name, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(root_key) DO UPDATE SET enabled = 1, generation = generation + 1 WHERE enabled = 0
    `).run(randomUUID(), root, pathKey(root), name, timestamp())
    return this.#db.prepare('SELECT id, root, name FROM libraries WHERE root_key = ?').get(pathKey(root))
  }

  libraries() {
    return this.#db.prepare(`
      SELECT l.id, l.root, l.name, l.indexed_at AS indexedAt, l.watch_enabled AS watching,
        (SELECT json_group_array(w.format ORDER BY w.format) FROM package_watch_libraries w WHERE w.library_id = l.id) AS packageWatchFormats,
        COUNT(a.id) AS assets,
        COUNT(CASE WHEN a.kind = 'model' THEN 1 END) AS models,
        COUNT(CASE WHEN a.kind = 'image' THEN 1 END) AS images,
        COALESCE(SUM(a.size), 0) AS bytes
      FROM libraries l LEFT JOIN assets a ON a.library_id = l.id AND a.missing_since IS NULL
      WHERE l.enabled = 1 GROUP BY l.id ORDER BY l.name, l.id
    `).all().map(library => {
      const packageWatchFormats = JSON.parse(library.packageWatchFormats)
      return { ...library, watching: Boolean(library.watching), packageWatchFormats, packageWatching: packageWatchFormats.includes('unitypackage') }
    })
  }

  watchedLibraries() {
    return this.#db.prepare(`SELECT id, root FROM libraries WHERE enabled = 1 AND (watch_enabled = 1 OR EXISTS (
      SELECT 1 FROM package_watch_libraries WHERE library_id = libraries.id
    ))`).all()
  }

  setWatching(id, enabled) {
    validateId(id)
    if (typeof enabled !== 'boolean') throw new IndexInputError('Укажите, включено ли наблюдение.')
    return transaction(this.#db, () => {
      const library = this.#db.prepare('UPDATE libraries SET watch_enabled = ? WHERE id = ? AND enabled = 1 RETURNING id')
        .get(Number(enabled), id)
      if (!library) throw new IndexInputError('Библиотека не подключена.')
      if (!enabled && !this.#db.prepare('SELECT 1 FROM package_watch_libraries WHERE library_id = ?').get(id)) this.jobs.cancelWatch(id)
      return { id, watching: enabled }
    })
  }

  setPackageWatching(id, enabled, ignoredPaths = [], format = 'unitypackage') {
    validateId(id)
    if (typeof enabled !== 'boolean') throw new IndexInputError('Укажите, включён ли автоимпорт.')
    if (typeof format !== 'string' || !watchedPackageRecipe(format)) throw new IndexInputError('Выберите формат автоимпорта.')
    return transaction(this.#db, () => {
      const library = this.#db.prepare('SELECT root, watch_enabled AS watching FROM libraries WHERE id = ? AND enabled = 1').get(id)
      if (!library) throw new IndexInputError('Библиотека не подключена.')
      if (enabled) {
        if (ignoredPaths.some(path => inside(path, library.root))) throw new IndexInputError('Выберите папку с исходными пакетами вне каталогов результатов и кеша.')
        this.#db.prepare('INSERT OR IGNORE INTO package_watch_libraries (library_id, format) VALUES (?, ?)').run(id, format)
      } else {
        this.#db.prepare('DELETE FROM package_watch_libraries WHERE library_id = ? AND format = ?').run(id, format)
        this.jobs.cancelPackageWatch(id, format)
      }
      const packageWatchFormats = this.#db.prepare('SELECT format FROM package_watch_libraries WHERE library_id = ? ORDER BY format')
        .all(id).map(setting => setting.format)
      if (!library.watching && !packageWatchFormats.length) this.jobs.cancelWatch(id)
      return { id, packageWatchFormats, packageWatching: packageWatchFormats.includes('unitypackage') }
    })
  }

  disconnect(id) {
    validateId(id)
    return transaction(this.#db, () => {
      const { changes } = this.#db.prepare(`
        UPDATE libraries SET enabled = 0, watch_enabled = 0, generation = generation + 1
        WHERE id = ? AND enabled = 1
      `).run(id)
      if (changes) {
        this.#db.prepare('DELETE FROM package_watch_libraries WHERE library_id = ?').run(id)
        this.jobs.cancelWatch(id)
        this.jobs.cancelPackageWatch(id)
        this.jobs.cancelThumbnails(id)
      }
      return Boolean(changes)
    })
  }

  async scan(id, { signal, onProgress, beforeCommit, onCommit } = {}) {
    validateId(id)
    if (this.#scans.has(id)) return this.#scans.get(id)
    const pending = this.#scan(id, signal, onProgress, beforeCommit, onCommit)
    this.#scans.set(id, pending)
    try {
      return await pending
    } finally {
      this.#scans.delete(id)
    }
  }

  async #scan(id, signal, onProgress, beforeCommit, onCommit) {
    const library = this.#db.prepare('SELECT * FROM libraries WHERE id = ? AND enabled = 1').get(id)
    if (!library) throw new IndexInputError('Библиотека не подключена.')
    const previous = this.#db.prepare(`
      SELECT a.*, p.processor_version, s.source_key AS serialized_key, s.resources AS serialized_resources
      FROM assets a LEFT JOIN asset_analysis p ON p.asset_id = a.id
      LEFT JOIN serialized_package_sources s ON s.asset_id = a.id
      WHERE a.library_id = ?
    `).all(id)
    const byPath = new Map(previous.map(item => [item.path_key, item]))
    const discovered = new Map()
    let hashed = 0
    let reused = 0
    let skippedHashes = 0
    for await (const file of discoverAssets(library.root, { strict: true, signal })) {
      const key = pathKey(file.path)
      if (discovered.has(key)) throw new IndexInputError('В папке обнаружены имена, отличающиеся только регистром.')
      const existing = byPath.get(key)
      const { size, mtimeMs: mtime, ctimeMs: ctime } = file.info
      let hash = null
      if (size > (file.ext === 'pak' ? maxPakInput : maxHashedSize)) {
        skippedHashes++
      } else if (existing?.hash && existing.size === size && existing.mtime === mtime && existing.ctime === ctime) {
        hash = existing.hash
        reused++
      } else {
        hash = await hashFile(library.root, file.absolute, file.info, signal)
        hashed++
      }
      const canReuse = existing?.processor_version === analysisVersion && existing.path === file.path &&
        (hash !== null ? existing.hash === hash : existing.size === size && existing.mtime === mtime && existing.ctime === ctime)
      const analysis = supportsAnalysis(file.ext) && !canReuse ? await analyzeAsset(library.root, file, signal) : null
      const serialized = hash && watchedFormatByExtension.get(file.ext) === 'unity-serialized' ?
        await watchSerializedSource(library.root, file, hash, existing?.serialized_resources, signal) : null
      discovered.set(key, { path: file.path, name: basename(file.path), ext: file.ext,
        kind: file.kind, size, mtime, ctime, hash, analysis, serialized })
      onProgress?.(discovered.size)
    }
    signal?.throwIfAborted()
    const summary = { assets: discovered.size, added: 0, changed: 0, moved: 0, missing: 0, hashed, reused, skippedHashes }
    // A failed walk leaves the last successful scan intact. Never commit a stale scan from another process.
    return transaction(this.#db, () => {
      beforeCommit?.()
      signal?.throwIfAborted()
      const now = timestamp()
      const { changes } = this.#db.prepare(`
        UPDATE libraries SET indexed_at = ?, generation = generation + 1
        WHERE id = ? AND generation = ? AND enabled = 1
      `).run(now, id, library.generation)
      if (!changes) throw new IndexInputError('Состояние библиотеки изменилось. Повторите сканирование.')
      this.#recordScan(id, now, discovered, previous, byPath, summary)
      onCommit?.(summary)
      return summary
    })
  }

  #recordScan(id, now, discovered, previous, byPath, summary) {
    const oldHashes = countHashes(previous.filter(item => !item.missing_since))
    const newHashes = countHashes(discovered.values())
    const unmatched = previous.filter(item => !item.missing_since && !discovered.has(item.path_key))
    const moves = new Map(unmatched.filter(item => oldHashes.get(item.hash) === 1 && newHashes.get(item.hash) === 1)
      .map(item => [item.hash, item]))
    const update = this.#db.prepare(`
      UPDATE assets SET path = ?, path_key = ?, name = ?, ext = ?, kind = ?, size = ?, mtime = ?, ctime = ?,
        hash = ?, missing_since = NULL, search_text = ? WHERE id = ?
    `)
    const insert = this.#db.prepare(`
      INSERT INTO assets(id, library_id, path, path_key, name, ext, kind, size, mtime, ctime, hash, first_seen, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const version = this.#db.prepare('INSERT INTO asset_versions(asset_id, path, size, mtime, hash, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
    const markMissing = this.#db.prepare('UPDATE assets SET missing_since = ? WHERE id = ?')
    const removeSerialized = this.#db.prepare('DELETE FROM serialized_package_sources WHERE asset_id = ?')
    const saveSerialized = this.#db.prepare(`INSERT INTO serialized_package_sources (asset_id, source_key, resources)
      VALUES (?, ?, ?) ON CONFLICT(asset_id) DO UPDATE SET source_key = excluded.source_key, resources = excluded.resources`)
    const fields = this.#db.prepare('SELECT category, tags, note, license FROM assets WHERE id = ?')
    const deleteAnalysis = this.#db.prepare('DELETE FROM asset_analysis WHERE asset_id = ?')
    const saveAnalysis = this.#db.prepare('INSERT INTO asset_analysis (asset_id, processor_version, report) VALUES (?, ?, ?)')
    const saveDependency = this.#db.prepare(`
      INSERT INTO asset_dependencies (asset_id, ordinal, role, location, path, path_key, dimensions) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const [key, file] of discovered) {
      const data = [file.path, key, file.name, file.ext, file.kind, file.size, file.mtime, file.ctime, file.hash]
      const present = byPath.get(key)
      const before = present ?? moves.get(file.hash)
      const assetId = before?.id ?? randomUUID()
      if (before) {
        const changed = before.size !== file.size || before.hash !== file.hash || before.mtime !== file.mtime || before.path !== file.path
        if (changed || before.missing_since || before.ctime !== file.ctime) {
          // A review can be edited while hashing runs. Read its latest search fields under the write lock.
          const metadata = fields.get(assetId)
          update.run(...data, content(file.path, metadata), assetId)
          if (changed || before.missing_since) version.run(assetId, file.path, file.size, file.mtime, file.hash, now)
          if (present) {
            summary.changed++
          } else {
            summary.moved++
            moves.delete(file.hash)
            before.moved = true
          }
        }
      } else {
        insert.run(assetId, id, ...data, now, content(file.path))
        version.run(assetId, file.path, file.size, file.mtime, file.hash, now)
        summary.added++
      }
      if (file.serialized && (file.serialized.key !== before?.serialized_key || file.serialized.resources !== before?.serialized_resources)) {
        saveSerialized.run(assetId, file.serialized.key, file.serialized.resources)
      } else if (!file.serialized && before?.serialized_key) {
        removeSerialized.run(assetId)
      }
      if (file.analysis || (before?.processor_version && !supportsAnalysis(file.ext))) deleteAnalysis.run(assetId)
      if (file.analysis) {
        const { dependencies, ...report } = file.analysis
        saveAnalysis.run(assetId, analysisVersion, JSON.stringify(report))
        for (const [order, item] of dependencies.entries()) {
          saveDependency.run(assetId, order, item.role, item.location, item.path, item.key,
            item.dimensions ? JSON.stringify(item.dimensions) : null)
        }
      }
    }
    for (const file of unmatched) if (!file.moved) {
      markMissing.run(now, file.id)
      summary.missing++
    }
  }

  search({ q = '', libraryId, libraryIds, kind, hash, limit = 50, offset = 0 } = {}) {
    const query = folded(stringField(q, 200))
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new IndexInputError('Некорректная страница результатов.')
    }
    const condition = ['l.enabled = 1', 'a.missing_since IS NULL']
    const args = []
    allowedLibraries(condition, args, libraryIds)
    if (libraryId) {
      validateId(libraryId)
      condition.push('a.library_id = ?')
      args.push(libraryId)
    }
    if (kind) {
      if (!kinds.has(kind)) throw new IndexInputError('Неизвестный тип файла.')
      condition.push('a.kind = ?')
      args.push(kind)
    }
    if (hash) {
      if (typeof hash !== 'string' || !/^[\da-f]{64}$/.test(hash)) throw new IndexInputError('Некорректный SHA-256.')
      condition.push('a.hash = ?')
      args.push(hash)
    }
    const terms = query.split(/\s+/).filter(Boolean)
    const indexed = terms.filter(term => [...term].length >= 3)
    if (indexed.length) {
      condition.push('a.rowid IN (SELECT rowid FROM asset_search WHERE asset_search MATCH ?)')
      args.push(indexed.map(term => '"' + term.replaceAll('"', '""') + '"').join(' AND '))
    }
    for (const term of terms.filter(term => [...term].length < 3)) {
      condition.push('instr(a.search_text, ?) > 0')
      args.push(term)
    }
    const found = this.#db.prepare(`
      SELECT ${readable} FROM assets a JOIN libraries l ON a.library_id = l.id
      WHERE ${condition.join(' AND ')} ORDER BY a.name COLLATE NOCASE, a.id LIMIT ? OFFSET ?
    `).all(...args, limit + 1, offset)
    return { assets: found.slice(0, limit).map(shape), nextOffset: found.length > limit ? offset + limit : null }
  }

  asset(id) {
    validateId(id)
    return shape(this.#db.prepare(`
      SELECT ${readable}, l.root, l.generation FROM assets a JOIN libraries l ON a.library_id = l.id
      WHERE a.id = ? AND l.enabled = 1
    `).get(id))
  }

  thumbnailSource(id, libraryIds) {
    validateId(id)
    const asset = this.#db.prepare(`SELECT a.id, a.library_id AS libraryId, a.path, a.ext, a.size, a.hash,
      a.mtime, a.ctime, a.missing_since AS missingSince, l.root FROM assets a JOIN libraries l ON a.library_id = l.id
      WHERE a.id = ? AND l.enabled = 1`).get(id)
    if (!asset || (libraryIds !== undefined && !libraryIds.includes(asset.libraryId))) return null
    const dependencies = asset.ext === 'obj' ? [] : this.#db.prepare(`
      SELECT d.location, d.path AS reference, b.path, b.size, b.hash, b.mtime, b.ctime
      FROM asset_dependencies d LEFT JOIN assets b ON b.library_id = ? AND b.path_key = d.path_key AND b.missing_since IS NULL
      WHERE d.asset_id = ? AND d.role = 'buffer' AND d.location <> 'embedded' ORDER BY d.ordinal`).all(asset.libraryId, id)
    return thumbnailPlan(asset, dependencies)
  }

  inspect(id, { libraryIds, profileId } = {}) {
    const asset = this.asset(id)
    if (!asset || (libraryIds !== undefined && !libraryIds.includes(asset.libraryId))) return undefined
    const analysis = this.#analysis(asset)
    const details = { asset, versions: this.versions(id), analysis }
    if (profileId !== undefined) details.validation = validateQuality(asset, analysis, this.qualityProfiles.get(profileId))
    return details
  }

  #analysis(asset) {
    const saved = this.#db.prepare('SELECT report FROM asset_analysis WHERE asset_id = ?').get(asset.id)
    if (!saved) return { status: supportsAnalysis(asset.ext) ? 'pending' : 'unsupported', metrics: {},
      issues: [], dependencies: [], dependenciesTruncated: false, dependenciesComplete: false }
    const report = JSON.parse(saved.report)
    const read = this.#db.prepare(`
      SELECT d.role, d.location, d.path, d.dimensions, b.id AS targetId, b.path AS targetPath, p.report
      FROM asset_dependencies d
      LEFT JOIN assets b ON b.library_id = ? AND b.path_key = d.path_key AND b.missing_since IS NULL
      LEFT JOIN asset_analysis p ON p.asset_id = b.id
      WHERE d.asset_id = ? ORDER BY d.ordinal
    `)
    const dependencies = []
    const materialLibraries = new Map()
    let completeMaterials = true
    function add(rows, via = null) {
      for (const { role, location, path, dimensions, targetId, targetPath, report: targetReport } of rows) {
        if (dependencies.length >= dependencyLimit) {
          report.dependenciesTruncated = true
          break
        }
        const target = targetReport ? JSON.parse(targetReport) : null
        dependencies.push({ role, path, via, targetId,
          status: location === 'local' ? (targetId ? 'available' : identifyAsset(path) ? 'unavailable' : 'unindexed') : location,
          dimensions: dimensions ? JSON.parse(dimensions) : target?.metrics.width && target?.metrics.height
            ? { width: target.metrics.width, height: target.metrics.height } : null })
        if (!via && role === 'material-library') {
          if (targetId) materialLibraries.set(targetId, targetPath)
          completeMaterials &&= target?.status === 'analyzed'
          if (target?.dependenciesTruncated) report.dependenciesTruncated = true
          if (target?.status === 'invalid' && !report.issues.includes('invalid-material-library')) {
            report.issues.push('invalid-material-library')
            if (report.status === 'analyzed') report.status = 'partial'
          }
        }
      }
    }
    add(read.all(asset.libraryId, asset.id))
    for (const [id, path] of materialLibraries) {
      if (dependencies.length >= dependencyLimit) {
        report.dependenciesTruncated = true
        break
      }
      add(read.all(asset.libraryId, id), path)
    }
    if (asset.ext === 'obj' && report.status !== 'invalid' && report.status !== 'limited') {
      const images = dependencies.filter(item => item.role === 'image')
      report.metrics.textures = completeMaterials && !report.dependenciesTruncated && images.every(item => item.path)
        ? new Set(images.map(item => pathKey(item.path))).size : null
    }
    const dependenciesComplete = ['analyzed', 'partial'].includes(report.status) && completeMaterials &&
      !report.dependenciesTruncated && !report.issues.includes('unreadable-texture-reference')
    return { ...report, dependencies, dependenciesComplete }
  }

  updateAsset(id, change) {
    validateId(id)
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new IndexInputError('Некорректные метаданные.')
    const allowed = ['category', 'tags', 'note', 'review', 'license']
    if (Object.keys(change).some(key => !allowed.includes(key))) throw new IndexInputError('Неизвестное поле метаданных.')
    return transaction(this.#db, () => {
      const before = this.asset(id)
      if (!before) throw new IndexInputError('Ассет отсутствует.')
      const record = { ...before, ...change }
      if (!Array.isArray(record.tags) || record.tags.length > 32 || !reviews.has(record.review)) {
        throw new IndexInputError('Некорректные теги или решение.')
      }
      record.category = stringField(record.category, 80)
      record.tags = JSON.stringify([...new Set(record.tags.map(tag => stringField(tag, 60)).filter(Boolean))])
      record.note = stringField(record.note, 1200)
      record.license = stringField(record.license, 300)
      this.#db.prepare('UPDATE assets SET category = ?, tags = ?, note = ?, review = ?, license = ?, search_text = ? WHERE id = ?')
        .run(record.category, record.tags, record.note, record.review, record.license, content(record.path, record), id)
      return this.asset(id)
    })
  }

  versions(id) {
    if (!this.asset(id)) return []
    return this.#db.prepare(`
      SELECT path, size, mtime, hash, recorded_at AS recordedAt FROM asset_versions
      WHERE asset_id = ? ORDER BY version DESC LIMIT 100
    `).all(id)
  }

  duplicates(limit = 50, offset = 0, libraryIds) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new IndexInputError('Некорректная страница результатов.')
    }
    const condition = ['l.enabled = 1', 'a.missing_since IS NULL', 'a.hash IS NOT NULL']
    const args = []
    allowedLibraries(condition, args, libraryIds)
    return this.#db.prepare(`
      SELECT a.hash, COUNT(*) AS count, MAX(a.size) AS size FROM assets a JOIN libraries l ON a.library_id = l.id
      WHERE ${condition.join(' AND ')}
      GROUP BY a.hash HAVING COUNT(*) > 1 ORDER BY count DESC, a.hash LIMIT ? OFFSET ?
    `).all(...args, limit, offset)
  }

  exportMetadata(libraryId) {
    const condition = ['l.enabled = 1', 'a.missing_since IS NULL']
    const args = []
    if (libraryId) allowedLibraries(condition, args, [libraryId])
    const rows = this.#db.prepare(`
      SELECT ${readable} FROM assets a JOIN libraries l ON a.library_id = l.id
      WHERE ${condition.join(' AND ')} ORDER BY a.name COLLATE NOCASE, a.id
    `)
    return { version: 1, assets: [...rows.iterate(...args)].map(shape) }
  }

  integrity() {
    const rows = this.#db.prepare('PRAGMA quick_check').all()
    const ok = rows.length === 1 && rows[0].quick_check === 'ok' && !this.#db.prepare('PRAGMA foreign_key_check').get()
    return { ok, schemaVersion, checks: rows.map(row => row.quick_check) }
  }

  async backup(directory) {
    await mkdir(directory, { recursive: true })
    const destination = join(directory, 'index-' + randomUUID() + '.sqlite')
    const partial = destination + '.partial'
    try {
      await backup(this.#db, partial)
      await rename(partial, destination)
      return destination
    } finally {
      await rm(partial, { force: true })
    }
  }
}
