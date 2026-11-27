import { join, relative } from 'node:path'
import { inside, pathKey, portablePath } from '../files/asset-files.mjs'

export function queueWatchedPackages(db, slots, ignoredPaths, enqueue) {
  if (slots <= 0) return 0
  const libraries = db.prepare(`SELECT l.id, l.root FROM libraries l JOIN package_watch_libraries w ON w.library_id = l.id
    WHERE l.enabled = 1 ORDER BY l.id`).all()
  const remember = db.prepare(`INSERT INTO package_watch_imports (library_id, path_key, source_path, source_key, job_id)
    VALUES (?, ?, ?, ?, ?)`)
  let queued = 0
  for (const { id, root } of libraries) {
    if (ignoredPaths.some(path => inside(path, root))) continue
    const prefixes = ignoredPaths.filter(path => inside(root, path)).map(path => pathKey(portablePath(relative(root, path))) + '/')
    const exclusions = prefixes.map(() => ' AND substr(a.path_key, 1, length(?)) <> ?').join('')
    const find = db.prepare(`SELECT a.rowid, a.path_key AS pathKey, a.path, a.hash FROM assets a
      WHERE a.library_id = ? AND a.ext = 'unitypackage' AND a.missing_since IS NULL AND a.hash IS NOT NULL
        AND a.rowid > ?${exclusions} AND NOT EXISTS (
          SELECT 1 FROM package_watch_imports w WHERE w.library_id = a.library_id AND w.path_key = a.path_key AND w.source_key = a.hash
        ) ORDER BY a.rowid LIMIT ?`)
    const exclusionsArgs = prefixes.flatMap(prefix => [prefix, prefix])
    let cursor = 0
    while (queued < slots) {
      const candidates = find.all(id, cursor, ...exclusionsArgs, slots - queued)
      if (!candidates.length) break
      for (const candidate of candidates) {
        cursor = candidate.rowid
        const job = enqueue(join(root, candidate.path), candidate.hash)
        if (!job) continue
        remember.run(id, candidate.pathKey, candidate.path, candidate.hash, job.id)
        queued++
      }
    }
    if (queued >= slots) break
  }
  return queued
}
