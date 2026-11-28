export function removePackageWatchSchema(db) {
  db.exec('DROP TABLE serialized_package_sources; DROP TABLE package_watch_imports; DROP TABLE package_watch_libraries; DROP INDEX live_watched_packages;')
}

export function removePackageImportPauseSchema(db) {
  db.exec('ALTER TABLE processing_jobs DROP COLUMN pause_requested;')
}
