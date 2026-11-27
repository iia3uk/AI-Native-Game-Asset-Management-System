export const packageWatch = `
  CREATE TABLE IF NOT EXISTS package_watch_libraries (
    library_id TEXT PRIMARY KEY REFERENCES libraries(id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS package_watch_imports (
    library_id TEXT NOT NULL REFERENCES libraries(id),
    path_key TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_key TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE REFERENCES processing_jobs(id),
    PRIMARY KEY (library_id, path_key, source_key)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS live_unity_packages ON assets (library_id)
    WHERE ext = 'unitypackage' AND missing_since IS NULL AND hash IS NOT NULL;
`

export const packageWatchByFormat = `
  ALTER TABLE package_watch_libraries RENAME TO legacy_package_watch_libraries;
  CREATE TABLE package_watch_libraries (
    library_id TEXT NOT NULL REFERENCES libraries(id),
    format TEXT NOT NULL CHECK (format IN ('unitypackage', 'unityfs', 'unreal-pak')),
    PRIMARY KEY (library_id, format)
  ) STRICT;
  INSERT INTO package_watch_libraries (library_id, format)
    SELECT library_id, 'unitypackage' FROM legacy_package_watch_libraries;
  DROP TABLE legacy_package_watch_libraries;

  ALTER TABLE package_watch_imports ADD COLUMN format TEXT NOT NULL DEFAULT 'unitypackage'
    CHECK (format IN ('unitypackage', 'unityfs', 'unreal-pak'));
  DROP INDEX live_unity_packages;
  CREATE INDEX live_watched_packages ON assets (library_id, ext)
    WHERE ext IN ('unitypackage', 'bundle', 'unity3d', 'pak') AND missing_since IS NULL AND hash IS NOT NULL;
`
