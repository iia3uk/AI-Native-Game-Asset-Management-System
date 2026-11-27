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
