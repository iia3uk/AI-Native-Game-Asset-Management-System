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

export const schemaVersion = 4

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
    db.exec('PRAGMA user_version = ' + schemaVersion)
  })
}
