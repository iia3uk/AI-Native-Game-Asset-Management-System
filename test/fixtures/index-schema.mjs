import { packageWatch, packageWatchByFormat, packageWatchSerialized } from '../../core/index/schema/package-watch.mjs'

export function removePackageWatchSchema(db) {
  db.exec('DROP TABLE watched_package_sources; DROP TABLE package_watch_imports; DROP TABLE package_watch_libraries; DROP INDEX live_watched_packages;')
}

export function removeIoStoreWatchSchema(db) {
  db.exec(`CREATE TEMP TABLE saved_package_watch_settings AS SELECT * FROM package_watch_libraries;
    CREATE TEMP TABLE saved_package_watch_jobs AS SELECT * FROM package_watch_imports;
    ALTER TABLE watched_package_sources RENAME TO saved_package_watch_sources;
    DROP TABLE package_watch_imports;
    DROP TABLE package_watch_libraries;
    DROP INDEX live_watched_packages;
    ${packageWatch}
    ${packageWatchByFormat}
    ${packageWatchSerialized}
    INSERT INTO package_watch_libraries SELECT * FROM saved_package_watch_settings;
    INSERT INTO package_watch_imports SELECT * FROM saved_package_watch_jobs;
    INSERT INTO serialized_package_sources SELECT * FROM saved_package_watch_sources;
    DROP TABLE saved_package_watch_settings;
    DROP TABLE saved_package_watch_jobs;
    DROP TABLE saved_package_watch_sources;`)
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
