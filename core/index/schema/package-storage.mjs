export const packageOutputRoots = `
  CREATE TABLE package_output_roots (
    id TEXT PRIMARY KEY NOT NULL,
    destination TEXT NOT NULL,
    destination_key TEXT NOT NULL,
    destination_dev TEXT NOT NULL,
    destination_ino TEXT NOT NULL,
    root TEXT NOT NULL UNIQUE,
    dev TEXT NOT NULL,
    ino TEXT NOT NULL,
    UNIQUE (destination_key, destination_dev, destination_ino)
  );
  ALTER TABLE processing_jobs ADD COLUMN output_root_id TEXT REFERENCES package_output_roots (id)
    CHECK (output_root_id IS NULL OR type = 'package-import');
  ALTER TABLE libraries ADD COLUMN output_root_id TEXT REFERENCES package_output_roots (id);
  ALTER TABLE libraries ADD COLUMN output_dev TEXT;
  ALTER TABLE libraries ADD COLUMN output_ino TEXT;
  DROP INDEX one_active_import_per_package;
  CREATE UNIQUE INDEX one_active_import_per_package
    ON processing_jobs (package_path, source_key, export_formats, engine_mode, editor_version, COALESCE(output_root_id, ''))
    WHERE type = 'package-import' AND status IN ('pending','running');
`
