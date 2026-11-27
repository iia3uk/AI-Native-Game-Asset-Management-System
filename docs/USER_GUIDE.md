# User guide

## Preview an asset

Open **Демобиблиотека** to try the generated cabin, pine and rocks, and textured pennant. Select a group on the left and an asset on the right. Use the mouse to orbit and zoom. Toggle **Сетка** for wireframe or **Часть** to inspect a single part. The cabin has a **Turntable** clip available in the animation controls.

Use **Локальные папки** to open an existing folder without creating a database library. Use the existing **Fab** tab for an optional Fab catalog. For the full list of formats and texture overrides, see [README.ru.md](../README.ru.md).

## Connect and search a library

Open **Индекс**, choose or enter the absolute folder path, then click **Подключить и сканировать**. Filter by library and file type. Search accepts substrings in paths, names, formats, categories, tags, notes and license text.

Select a result to edit its metadata or click **Открыть во вьювере**. Use **Пересканировать** when a library changes. Disconnected libraries disappear from results. Reconnecting the same root restores its records. Originals remain in place.

Scans keep running if you close the index dialog. Open it and select the library to see progress or the last result. Use **Отменить сканирование** while a job is active. Use **Повторить задание** after a failure or interruption. Queued jobs persist across restarts.

## Data, backups and export

On Windows, the database and backups live under `%APPDATA%\AssetViewer`. Demo assets and cache data live under `%LOCALAPPDATA%\AssetViewer`. Other platforms use their application data and cache directories. `ASSET_VIEWER_DATA_DIR` overrides data paths with an absolute directory for source or desktop sessions.

```sh
npm run cli -- doctor
npm run cli -- backup
node scripts/asset-viewer.mjs export > asset-metadata.json
```

If a database cannot open, keep the file and its SQLite sidecars for recovery. To try a backup, close Asset Viewer and copy the backup into a new isolated data directory as `index.sqlite`. Launch with `ASSET_VIEWER_DATA_DIR` set to that directory, check the data and run `doctor`. This is a manual recovery workflow.
