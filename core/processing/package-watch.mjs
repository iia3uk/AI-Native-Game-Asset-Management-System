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
    const find = db.prepare(`WITH candidates AS (
      SELECT a.rowid, a.library_id, a.path_key, a.path, a.ext,
        CASE WHEN a.ext IN ('asset', 'assets', 'sharedassets', 'utoc') THEN s.source_key
             WHEN a.ext IN ('bundle', 'unity3d') THEN COALESCE(s.source_key, a.hash) ELSE a.hash END AS source_key
      FROM assets a LEFT JOIN watched_package_sources s ON s.asset_id = a.id
      WHERE a.library_id = ? AND a.ext IN ('unitypackage', 'bundle', 'unity3d', 'pak', 'asset', 'assets', 'sharedassets', 'utoc')
        AND a.ext IN (${extensions.map(() => '?').join(', ')}) AND a.missing_since IS NULL AND a.hash IS NOT NULL
        AND a.rowid > ?${exclusions}
    )
    SELECT c.rowid, c.path_key AS pathKey, c.path, c.source_key AS sourceKey, c.ext FROM candidates c
    WHERE c.source_key IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM package_watch_imports w WHERE w.library_id = c.library_id AND w.path_key = c.path_key AND w.source_key = c.source_key
    ) ORDER BY c.rowid LIMIT ?`)
    const exclusionsArgs = prefixes.flatMap(prefix => [prefix, prefix])
    let cursor = 0
    while (queued < slots) {
      const candidates = find.all(id, ...extensions, cursor, ...exclusionsArgs, slots - queued)
      if (!candidates.length) break
      for (const candidate of candidates) {
        cursor = candidate.rowid
        const format = watchedFormatByExtension.get(candidate.ext)
        const job = enqueue(join(root, candidate.path), candidate.sourceKey, watchedPackageRecipe(format).formats)
        if (!job) continue
        remember.run(id, candidate.pathKey, candidate.path, candidate.sourceKey, job.id, format)
        queued++
      }
    }
    if (queued >= slots) break
  }
  return queued
}
