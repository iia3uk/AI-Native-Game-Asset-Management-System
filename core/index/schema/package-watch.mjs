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

export const packageWatchSerialized = `
  ALTER TABLE package_watch_libraries RENAME TO previous_package_watch_libraries;
  ALTER TABLE package_watch_imports RENAME TO previous_package_watch_imports;
  CREATE TABLE package_watch_libraries (
    library_id TEXT NOT NULL REFERENCES libraries(id),
    format TEXT NOT NULL CHECK (format IN ('unitypackage', 'unityfs', 'unreal-pak', 'unity-serialized')),
    PRIMARY KEY (library_id, format)
  ) STRICT;
  CREATE TABLE package_watch_imports (
    library_id TEXT NOT NULL REFERENCES libraries(id),
    path_key TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_key TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE REFERENCES processing_jobs(id),
    format TEXT NOT NULL CHECK (format IN ('unitypackage', 'unityfs', 'unreal-pak', 'unity-serialized')),
    PRIMARY KEY (library_id, path_key, source_key)
  ) STRICT;
  INSERT INTO package_watch_libraries SELECT library_id, format FROM previous_package_watch_libraries;
  INSERT INTO package_watch_imports
    SELECT library_id, path_key, source_path, source_key, job_id, format FROM previous_package_watch_imports;
  DROP TABLE previous_package_watch_libraries;
  DROP TABLE previous_package_watch_imports;
  DROP INDEX live_watched_packages;
  CREATE INDEX live_watched_packages ON assets (library_id, ext)
    WHERE ext IN ('unitypackage', 'bundle', 'unity3d', 'pak', 'asset', 'assets', 'sharedassets')
      AND missing_since IS NULL AND hash IS NOT NULL;
  CREATE TABLE serialized_package_sources (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    resources TEXT NOT NULL
  ) STRICT;
`

export const packageWatchIoStore = `
  ALTER TABLE serialized_package_sources RENAME TO watched_package_sources;
  ALTER TABLE package_watch_libraries RENAME TO previous_package_watch_libraries;
  ALTER TABLE package_watch_imports RENAME TO previous_package_watch_imports;
  CREATE TABLE package_watch_libraries (
    library_id TEXT NOT NULL REFERENCES libraries(id),
    format TEXT NOT NULL CHECK (format IN ('unitypackage', 'unityfs', 'unreal-pak', 'unity-serialized', 'unreal-iostore')),
    PRIMARY KEY (library_id, format)
  ) STRICT;
  CREATE TABLE package_watch_imports (
    library_id TEXT NOT NULL REFERENCES libraries(id),
    path_key TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_key TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE REFERENCES processing_jobs(id),
    format TEXT NOT NULL CHECK (format IN ('unitypackage', 'unityfs', 'unreal-pak', 'unity-serialized', 'unreal-iostore')),
    PRIMARY KEY (library_id, path_key, source_key)
  ) STRICT;
  INSERT INTO package_watch_libraries SELECT library_id, format FROM previous_package_watch_libraries;
  INSERT INTO package_watch_imports
    SELECT library_id, path_key, source_path, source_key, job_id, format FROM previous_package_watch_imports;
  DROP TABLE previous_package_watch_libraries;
  DROP TABLE previous_package_watch_imports;
  DROP INDEX live_watched_packages;
  CREATE INDEX live_watched_packages ON assets (library_id, ext)
    WHERE ext IN ('unitypackage', 'bundle', 'unity3d', 'pak', 'asset', 'assets', 'sharedassets', 'utoc')
      AND missing_since IS NULL AND hash IS NOT NULL;
`
