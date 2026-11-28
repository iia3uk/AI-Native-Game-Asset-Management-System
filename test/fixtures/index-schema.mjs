export function removePackageWatchSchema(db) {
  db.exec('DROP TABLE serialized_package_sources; DROP TABLE package_watch_imports; DROP TABLE package_watch_libraries; DROP INDEX live_watched_packages;')
}

export function removePackageImportPauseSchema(db) {
  db.exec('ALTER TABLE processing_jobs DROP COLUMN pause_requested;')
}

export function removePackageOutputStorageSchema(db) {
  db.exec(`DROP INDEX one_active_import_per_package;
    CREATE UNIQUE INDEX one_active_import_per_package ON processing_jobs
      (package_path, source_key, export_formats, engine_mode, editor_version)
      WHERE type = 'package-import' AND status IN ('pending','running');
    ALTER TABLE processing_jobs DROP COLUMN output_root_id;
    ALTER TABLE libraries DROP COLUMN output_root_id;
    ALTER TABLE libraries DROP COLUMN output_dev;
    ALTER TABLE libraries DROP COLUMN output_ino;
    DROP TABLE package_output_roots;`)
}
