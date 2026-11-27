export function removePackageWatchSchema(db) {
  db.exec('DROP TABLE serialized_package_sources; DROP TABLE package_watch_imports; DROP TABLE package_watch_libraries; DROP INDEX live_watched_packages;')
}
