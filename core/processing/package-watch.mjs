import { join, relative } from 'node:path'
import { inside, pathKey, portablePath } from '../files/asset-files.mjs'
import { watchedFormatByExtension, watchedPackageRecipe } from '../packages/watch-formats.mjs'

export function queueWatchedPackages(db, slots, ignoredPaths, enqueue) {
  if (slots <= 0) return 0
  const libraries = db.prepare(`SELECT DISTINCT l.id, l.root FROM libraries l JOIN package_watch_libraries w ON w.library_id = l.id
    WHERE l.enabled = 1 ORDER BY l.id`).all()
  const settings = db.prepare('SELECT format FROM package_watch_libraries WHERE library_id = ?')
  const remember = db.prepare(`INSERT INTO package_watch_imports (library_id, path_key, source_path, source_key, job_id, format)
    VALUES (?, ?, ?, ?, ?, ?)`)
  let queued = 0
  for (const { id, root } of libraries) {
    if (ignoredPaths.some(path => inside(path, root))) continue
    const extensions = settings.all(id).flatMap(({ format }) => watchedPackageRecipe(format).extensions)
    const prefixes = ignoredPaths.filter(path => inside(root, path)).map(path => pathKey(portablePath(relative(root, path))) + '/')
    const exclusions = prefixes.map(() => ' AND substr(a.path_key, 1, length(?)) <> ?').join('')
    const find = db.prepare(`SELECT a.rowid, a.path_key AS pathKey, a.path, a.hash, a.ext FROM assets a
      WHERE a.library_id = ? AND a.ext IN ('unitypackage', 'bundle', 'unity3d', 'pak')
        AND a.ext IN (${extensions.map(() => '?').join(', ')}) AND a.missing_since IS NULL AND a.hash IS NOT NULL
        AND a.rowid > ?${exclusions} AND NOT EXISTS (
          SELECT 1 FROM package_watch_imports w WHERE w.library_id = a.library_id AND w.path_key = a.path_key AND w.source_key = a.hash
        ) ORDER BY a.rowid LIMIT ?`)
    const exclusionsArgs = prefixes.flatMap(prefix => [prefix, prefix])
    let cursor = 0
    while (queued < slots) {
      const candidates = find.all(id, ...extensions, cursor, ...exclusionsArgs, slots - queued)
      if (!candidates.length) break
      for (const candidate of candidates) {
        cursor = candidate.rowid
        const format = watchedFormatByExtension.get(candidate.ext)
        const job = enqueue(join(root, candidate.path), candidate.hash, watchedPackageRecipe(format).formats)
        if (!job) continue
        remember.run(id, candidate.pathKey, candidate.path, candidate.hash, job.id, format)
        queued++
      }
    }
    if (queued >= slots) break
  }
  return queued
}
