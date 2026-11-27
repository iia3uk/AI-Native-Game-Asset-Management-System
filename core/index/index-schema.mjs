import { packageWatch, packageWatchByFormat, packageWatchSerialized } from './schema/package-watch.mjs'

const initial = `
  CREATE TABLE libraries (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    root_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    indexed_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    generation INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE assets (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    path TEXT NOT NULL,
    path_key TEXT NOT NULL,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('model', 'image', 'other')),
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    ctime REAL NOT NULL,
    hash TEXT,
    first_seen TEXT NOT NULL,
    missing_since TEXT,
    category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    review TEXT NOT NULL DEFAULT '' CHECK (review IN ('', 'candidate', 'later', 'excluded')),
    license TEXT NOT NULL DEFAULT '',
    search_text TEXT NOT NULL,
    UNIQUE (library_id, path_key)
  ) STRICT;

  CREATE INDEX live_assets_by_kind ON assets (kind, library_id) WHERE missing_since IS NULL;
  CREATE INDEX live_assets_by_hash ON assets (hash) WHERE missing_since IS NULL AND hash IS NOT NULL;
  CREATE INDEX assets_by_name ON assets (name, id);

  CREATE TABLE asset_versions (
    version INTEGER PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id),
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    hash TEXT,
    recorded_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX versions_by_asset ON asset_versions (asset_id, version);

  CREATE VIRTUAL TABLE asset_search USING fts5(search_text, content='assets', content_rowid='rowid', tokenize='trigram');
  CREATE TRIGGER asset_search_insert AFTER INSERT ON assets BEGIN
    INSERT INTO asset_search(rowid, search_text) VALUES (new.rowid, new.search_text);
  END;
  CREATE TRIGGER asset_search_update AFTER UPDATE OF search_text ON assets WHEN old.search_text <> new.search_text BEGIN
    INSERT INTO asset_search(asset_search, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
    INSERT INTO asset_search(rowid, search_text) VALUES (new.rowid, new.search_text);
  END;
`

const processing = `
  CREATE TABLE processing_jobs (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    type TEXT NOT NULL CHECK (type = 'scan'),
    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled','interrupted')),
    priority INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    error TEXT,
    worker TEXT,
    lease_until INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1))
  ) STRICT;
  CREATE UNIQUE INDEX one_active_job_per_library ON processing_jobs (library_id, type)
    WHERE status IN ('pending','running');
  CREATE INDEX pending_jobs ON processing_jobs (priority DESC, created_at) WHERE status = 'pending';
  CREATE INDEX jobs_by_library ON processing_jobs (library_id, created_at DESC);
`

const watching = `
  ALTER TABLE libraries ADD COLUMN watch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (watch_enabled IN (0, 1));
  ALTER TABLE processing_jobs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'watch'));
  CREATE INDEX watched_libraries ON libraries (id) WHERE enabled = 1 AND watch_enabled = 1;
`

const analysis = `
  CREATE TABLE asset_analysis (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    processor_version INTEGER NOT NULL,
    report TEXT NOT NULL CHECK (json_valid(report))
  ) STRICT;

  CREATE TABLE asset_dependencies (
    asset_id TEXT NOT NULL REFERENCES asset_analysis(asset_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('buffer', 'image', 'material-library')),
    location TEXT NOT NULL CHECK (location IN ('local', 'embedded', 'outside', 'external', 'unresolved')),
    path TEXT,
    path_key TEXT,
    dimensions TEXT CHECK (dimensions IS NULL OR json_valid(dimensions)),
    PRIMARY KEY (asset_id, ordinal),
    CHECK ((location = 'local') = (path IS NOT NULL AND path_key IS NOT NULL))
  ) STRICT;
`

const quality = `
  CREATE TABLE quality_profiles (
    profile_id TEXT PRIMARY KEY,
    limits TEXT CHECK (limits IS NULL OR json_valid(limits)),
    revision INTEGER NOT NULL CHECK (revision > 0)
  ) STRICT;
`

const packageJobs = previousVersion => `
  ALTER TABLE processing_jobs RENAME TO previous_processing_jobs;
  CREATE TABLE processing_jobs (
    id TEXT PRIMARY KEY,
    library_id TEXT REFERENCES libraries(id),
    type TEXT NOT NULL CHECK (type IN ('scan', 'thumbnail', 'package-import')),
    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled','interrupted')),
    priority INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    error TEXT,
    worker TEXT,
    lease_until INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'watch')),
    asset_id TEXT REFERENCES assets(id),
    source_key TEXT,
    package_path TEXT,
    CHECK ((type = 'thumbnail') = (asset_id IS NOT NULL)),
    CHECK ((type = 'scan') = (source_key IS NULL)),
    CHECK ((type = 'package-import') = (package_path IS NOT NULL)),
    CHECK (library_id IS NOT NULL OR type = 'package-import')
  ) STRICT;

  INSERT INTO processing_jobs (rowid, id, library_id, type, status, priority, created_at, started_at, finished_at,
    attempts, progress, result, error, worker, lease_until, cancel_requested, trigger, asset_id, source_key)
  SELECT rowid, id, library_id, type, status, priority, created_at, started_at, finished_at,
    attempts, progress, result, error, worker, lease_until, cancel_requested, trigger,
    ${previousVersion >= 6 ? 'asset_id, source_key' : 'NULL, NULL'} FROM previous_processing_jobs;
  DROP TABLE previous_processing_jobs;

  CREATE UNIQUE INDEX one_active_job_per_library ON processing_jobs (library_id)
    WHERE type = 'scan' AND status IN ('pending','running');
  CREATE UNIQUE INDEX one_active_thumbnail_per_source ON processing_jobs (asset_id, source_key)
    WHERE type = 'thumbnail' AND status IN ('pending','running');
  CREATE UNIQUE INDEX one_running_thumbnail ON processing_jobs (type) WHERE type = 'thumbnail' AND status = 'running';
  CREATE INDEX latest_thumbnail ON processing_jobs (asset_id, source_key, created_at DESC);
  CREATE UNIQUE INDEX one_active_import_per_package ON processing_jobs (package_path, source_key)
    WHERE type = 'package-import' AND status IN ('pending','running');
  CREATE UNIQUE INDEX one_running_import ON processing_jobs (type) WHERE type = 'package-import' AND status = 'running';
  CREATE INDEX pending_jobs ON processing_jobs (type, priority DESC, created_at) WHERE status = 'pending';
  CREATE INDEX jobs_by_library ON processing_jobs (library_id, created_at DESC);
`

const packageExports = `
  ALTER TABLE processing_jobs ADD COLUMN export_formats TEXT NOT NULL DEFAULT ''
    CHECK (export_formats IN ('', 'fbx', 'glb', 'fbx,glb') AND (type = 'package-import' OR export_formats = ''));
  DROP INDEX one_active_import_per_package;
  CREATE UNIQUE INDEX one_active_import_per_package ON processing_jobs (package_path, source_key, export_formats)
    WHERE type = 'package-import' AND status IN ('pending','running');
`

const engineMode = `
  ALTER TABLE processing_jobs ADD COLUMN engine_mode TEXT NOT NULL DEFAULT 'engineless'
    CHECK (engine_mode IN ('engineless', 'auto', 'engine-assisted') AND
      (type = 'package-import' OR engine_mode = 'engineless'));
  ALTER TABLE processing_jobs ADD COLUMN editor_version TEXT NOT NULL DEFAULT ''
    CHECK (length(editor_version) <= 32 AND (engine_mode != 'engineless' OR editor_version = ''));
  DROP INDEX one_active_import_per_package;
  CREATE UNIQUE INDEX one_active_import_per_package
    ON processing_jobs (package_path, source_key, export_formats, engine_mode, editor_version)
    WHERE type = 'package-import' AND status IN ('pending','running');
`

export const schemaVersion = 12

export function transaction(db, write) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = write()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function migrate(db) {
  const version = () => db.prepare('PRAGMA user_version').get().user_version
  const current = version()
  if (current === schemaVersion) return
  transaction(db, () => {
    // Another process may have finished migrating while this connection waited for the lock.
    const lockedVersion = version()
    if (lockedVersion > schemaVersion) throw new Error('The asset index was created by a newer version.')
    if (lockedVersion === 0) db.exec(initial)
    if (lockedVersion < 2) db.exec(processing)
    if (lockedVersion < 3) db.exec(watching)
    if (lockedVersion < 4) db.exec(analysis)
    if (lockedVersion < 5) db.exec(quality)
    if (lockedVersion < 7) db.exec(packageJobs(lockedVersion))
    if (lockedVersion < 8) db.exec(packageExports)
    if (lockedVersion < 9) db.exec(engineMode)
    if (lockedVersion < 10) db.exec(packageWatch)
    if (lockedVersion < 11) db.exec(packageWatchByFormat)
    if (lockedVersion < 12) db.exec(packageWatchSerialized)
    db.exec('PRAGMA user_version = ' + schemaVersion)
  })
}
