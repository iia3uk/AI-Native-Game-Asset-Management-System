# User guide

## Preview an asset

Open **Демобиблиотека** to try the generated cabin, pine and rocks, and textured pennant. Select a group on the left and an asset on the right. Use the mouse to orbit and zoom. Toggle **Сетка** for wireframe or **Часть** to inspect a single part. The cabin has a **Turntable** clip available in the animation controls.

Use **Локальные папки** to open an existing folder without creating a database library. Use the existing **Fab** tab for an optional Fab catalog. For the full list of formats and texture overrides, see [README.ru.md](../README.ru.md).

## Connect and search a library

Open **Индекс**, choose or enter the absolute folder path, then click **Подключить и сканировать**. Filter by library and file type. Search accepts substrings in paths, names, formats, categories, tags, notes and license text.

Select a result to edit its metadata or click **Открыть во вьювере**. Use **Пересканировать** when a library changes. Disconnected libraries disappear from results. Reconnecting the same root restores its records. Originals remain in place.

Scans keep running if you close the index dialog. Open it and select the library to see progress or the last result. Use **Отменить сканирование** while a job is active. Use **Повторить задание** after a failure or interruption. Queued jobs persist across restarts.

## Watch for changes

Select a library in **Индекс** and turn on **Следить за папкой**. This setting is off by default and applies to the selected library. Asset Viewer groups nearby changes into a scan. It keeps existing metadata and history when it can identify a moved file. Deletions mark files missing in the index and retain their metadata and history.

Watching runs while Asset Viewer or its local server is open. On startup, watched libraries are reconciled to catch changes made while it was closed. An incremental check runs every 15 minutes to catch missed notifications. These scans reuse existing hashes for files with matching fingerprints. Click the same button to turn watching off. **Пересканировать** remains available.

Use `npm run cli -- libraries` to find the library ID. Set its preference with `npm run cli -- watch <library-id> on` or `npm run cli -- watch <library-id> off`. The running server picks up CLI changes within a few seconds.

## Inspect a model and its textures

Select a result in **Индекс** and expand **Технический анализ**. For glTF 2.0, GLB, binary VRM and polygonal OBJ you can see geometry counts and known bounds, UVs, materials, texture dependencies, animation or skin information, and LOD and collision hints. LOD and collision hints can come from names. glTF bounds enclose the static scene using the position accessor bounds and node transforms. Bounds for skinned, morphed or instanced geometry may be unknown. OBJ triangle counts describe the triangulation of authored polygon faces. [glTF 2.0 accessor bounds](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#accessors-bounds)

Texture dimensions come from supported headers in PNG, JPEG, GIF, WebP, DDS and KTX2. Dependencies show whether each file is indexed, embedded, unavailable or external. An unavailable entry describes the current index snapshot. A manual or watched scan updates that snapshot. For older libraries, run **Пересканировать** to backfill analysis data. **Открыть во вьювере** remains available for supported preview formats.

To get the same report as JSON, use `npm run cli -- inspect <asset-id> --json`.

## Check against project budgets

In an asset's index card, select a profile under **Проверка по профилю**. Mobile Game, Desktop Game, Stylized Game, Realistic Game and VR have editable starting budgets. Custom Project starts empty. Set each budget through **Изменить пороги**. Leave a limit blank to skip that check. **Восстановить исходные** restores the selected profile's starting values.

The report explains each result and displays measured values beside thresholds. Size checks compare the largest side of the reported bounding box in source units. Texture budgets check the largest known pixel dimension. A texture with unknown dimensions leaves the check unknown unless another measured texture already exceeds the limit. Dependency checks use the index snapshot and leave externally referenced or unconfirmed files unknown. A structure check reports issues the analyzer found in the source sections it supports.

```sh
npm run cli -- profiles --json
npm run cli -- profile custom-project --set-json '{"maxTriangles":12000,"maxTextureEdge":2048,"requireUV":true}'
npm run cli -- inspect <asset-id> --profile custom-project --json
npm run cli -- profile custom-project --reset
```

Threshold updates through `--set-json` replace the saved limits for the selected profile.

## Data, backups and export

On Windows, the database and backups live under `%APPDATA%\AssetViewer`. Demo assets and cache data live under `%LOCALAPPDATA%\AssetViewer`. Other platforms use their application data and cache directories. `ASSET_VIEWER_DATA_DIR` overrides data paths with an absolute directory for source or desktop sessions.

```sh
npm run cli -- doctor
npm run cli -- backup
node scripts/asset-viewer.mjs export > asset-metadata.json
```

If a database cannot open, keep the file and its SQLite sidecars for recovery. To try a backup, close Asset Viewer and copy the backup into a new isolated data directory as `index.sqlite`. Launch with `ASSET_VIEWER_DATA_DIR` set to that directory, check the data and run `doctor`. This is a manual recovery workflow.
