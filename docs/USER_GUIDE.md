# User guide

## Preview an asset

Open **Демобиблиотека** to try the generated cabin, pine and rocks, and textured pennant. Select a group on the left and an asset on the right. Use the mouse to orbit and zoom. Toggle **Сетка** for wireframe or **Часть** to inspect a single part. The cabin has a **Turntable** clip available in the animation controls.

Use **Локальные папки** to open an existing folder without creating a database library. Use the existing **Fab** tab for an optional Fab catalog. For the full list of formats and texture overrides, see [README.ru.md](../README.ru.md).

## Connect and search a library

Open **Индекс**, choose or enter the absolute folder path, then click **Подключить и сканировать**. Filter by library and file type. Search accepts substrings in paths, names, formats, categories, tags, notes and license text.

Select a result to edit its metadata or click **Открыть во вьювере**. Use **Пересканировать** when a library changes. Disconnected libraries disappear from results. Reconnecting the same root restores its records. Originals remain in place.

Scans keep running if you close the index dialog. Open it and select the library to see progress or the last result. Use **Отменить сканирование** while a job is active. Use **Повторить задание** after a failure or interruption. Queued jobs persist across restarts.

## Import a Unity package

Open **Индекс → Импорт пакетов Unity и Unreal**. In the desktop app, select or drop up to 16 Unity packages, UnityFS containers or Unreal Pak archives. In the browser, enter the full local path and click **Проанализировать**. Expand a package to see its contents. Select **FBX** or **GLB-предпросмотр** to request Unity model exports, then choose **Обработать и добавить в индекс**. With multiple packages analyzed, **Обработать все пакеты** queues the remaining packages using settings supported by each format. The jobs list displays progress and offers cancellation or retry where available.

Use **Показать в индексе** after the scan completes. Supported originals such as FBX, GLB and PNG retain their original bytes and `Assets/` or `Packages/` paths. The application copies them into its data directory and uses the existing viewer. The report shows unavailable and excluded entries.

**Без Unity** is the default mode. **Авто** and **С Unity Editor** also allow an installed Unity 6000 final or patch release to export supported native objects. Enter a preferred Editor version or leave it blank to use a detected installation. Both modes use the direct pipeline for supported originals. The first Editor run may download the pinned FBX Exporter and its dependencies from the Unity registry. The job keeps the original assets and reports any Editor or per-asset export issue.

The job result shows the managed output directory. **Отчёт об импорте → Показать файлы** lists the result for each asset and model format. The original tree lives in `Source/`. With a format selected, the export also contains `Models/`, `Textures/`, `Materials/`, `Animations/`, `Audio/`, `Previews/` and `Metadata/`. Original FBX and GLB files can be copied directly. Blender 4.5 or newer can produce FBX and GLB derivatives from OBJ, glTF, GLB and binary FBX. Original textures are copied byte for byte. An FBX copied from the package can still need its external textures relinked. Individual conversion failures appear in the report and other assets continue.

The Unity bridge exports whole prefabs and their mesh renderers as individual FBX files, standalone transform animations as FBX, supported readable textures as PNG and material texture bindings as JSON. GLB previews of Unity geometry use Blender. Unity scenes, binary Unity assets, assets with custom serialized components and shader graphs remain source files or diagnostic entries.

The reports are `manifest.json`, `dependencies.json` and `conversion-report.json`. They record source paths, GUIDs, available file IDs, hashes, dependency status and how each artifact was made. An unchanged archive with the same mode, formats and tool installations reuses verified output. Custom destination folders and Fab package import remain pending.

```sh
npm run cli -- package-inspect "/absolute/path/example.unitypackage" --json
npm run cli -- package-import "/absolute/path/example.unitypackage" --dry-run --json
npm run cli -- package-import "/absolute/path/example.unitypackage" --json
npm run cli -- package-import "/absolute/path/example.unitypackage" --export fbx,glb --json
npm run cli -- package-import "/absolute/path/example.unitypackage" --mode engine-assisted --unity-version 6000.3.10f1 --export fbx,glb --json
npm run cli -- jobs --type package-import --json
```

The default CLI command waits for extraction and indexing. Add `--queue` to hand processing to the running desktop app or loopback server.

## Inspect and import a Unity AssetBundle

The importer recognizes stock UnityFS by its file signature. Select or drop a bundle in **Импорт пакетов Unity и Unreal**, or enter its path and click **Проанализировать**. Expand the result for the container version, Unity version and serialized object IDs. **Обработать и добавить в индекс** queues PNG and GLB output. Select **FBX** to request an additional Blender export. UnityFS always uses the independent decoder, including when it is submitted with `.unitypackage` files configured to use Unity Editor.

The Windows app includes the decoder. For source runs, follow the [worker build instructions](BUILD.md). The same interface is available in the CLI:

```sh
npm run cli -- package-inspect "/absolute/path/example.bundle" --json
npm run cli -- package-import "/absolute/path/example.bundle" --json
npm run cli -- package-import "/absolute/path/example.bundle" --export fbx --queue --json
```

Inspection lists the archive and Unity versions and up to 500 serialized objects with their IDs and support status. The worker handles stored and LZ4 blocks. It reads embedded type trees and publishes inline RGBA32 textures as PNG. It exports supported static triangle meshes as GLB with positions, normals, UV0 and separate submeshes. If Blender is unavailable, the GLB and PNG still reach the index.

The report marks unsupported layouts and classes. Meshes with skinning, blend shapes, mesh compression, extra vertex attributes or multiple vertex streams are outside the current decoder. Streamed textures, additional pixel formats, material bindings and bundle dependency analysis remain pending. A repeated import with the same SHA-256, output formats and tool versions reuses verified results.

## Automatically import a Unity package folder

Open **Индекс**, connect the folder with incoming `.unitypackage` files, select it under **Библиотека** and enable **Автоимпорт Unity**. Existing archives and new or changed files in subfolders are picked up while the app or local server is running. The importer extracts originals and requests FBX and GLB exports for supported models. This mode runs without Unity Editor and uses Blender where available. Follow progress and reports in **Импорт пакетов Unity и Unreal**. Results are indexed in managed libraries.

Turning off **Автоимпорт Unity** cancels active automatic imports for that source. Use **Повторить** in a job row to retry a failed, interrupted or cancelled import. The setting and the archive SHA-256 history survive restarts.

```sh
npm run cli -- libraries --json
npm run cli -- watch-packages <library-id> on --json
npm run cli -- jobs --type package-import --json
```

## Detect installed editors and Blender

Use **Найти установленные инструменты** in the Unity package importer, or run the diagnostics from the CLI. Discovery checks standard locations, Unity Hub, Epic Launcher metadata and Steam libraries where applicable. The package importer can still extract supported files when the list is empty.

```sh
npm run cli -- engines --json
npm run cli -- engines --unity-project "/absolute/path/UnityProject" --json
npm run cli -- engines --unreal-project "/absolute/path/Game.uproject" --json
```

The Unity check reports an exact project version if installed, or a candidate from the same release series. The Unreal check reports an installation matching the project association.

## Inspect and export Unreal content

Use `unreal-inspect` with a `.uproject`, its `Content` folder or an individual Unreal file. The inspection classifies supported loose package headers as editor, cooked, unversioned or unknown, recognizes standard Pak and IoStore headers and lists companion files. Project inspection reads up to 30,000 directory entries and returns counts and the first 500 matches. The command does not require Unreal Editor.

```sh
npm run cli -- unreal-inspect "/absolute/path/Project.uproject" --json
npm run cli -- unreal-export "/absolute/path/Project.uproject" --unreal-version 5.7 --json
```

`unreal-export` is an opt-in CLI preview for trusted editor content. Select a `.uproject` or a `Content` folder. It needs a locally discovered Unreal Editor 5.1 or newer and selects the associated build when available. For a folder without an association, it can use the latest compatible detected Editor. You can override the version. The temporary project uses bundled Python and only stages eligible assets under `/Game`. It reports missing dependencies and unsupported resources.

The bridge requests FBX for static meshes, skeletal meshes and animation sequences, PNG for supported textures and WAV for audio. Materials and standalone skeletons produce JSON metadata. Verified outputs publish under the app's managed import folder and discoverable files are added to the shared index. The manifest records source paths and hashes. The Editor bridge still needs end-to-end validation with a native Unreal installation.

Use **Индекс → Импорт пакетов Unity и Unreal** to inspect a stock Pak with a supported unencrypted index. The desktop window accepts files selected or dropped into the importer. The same path works in the CLI. Make the separate CUE4Parse executable available with the [worker build instructions](BUILD.md). Inspection lists up to 500 entries. Click **Обработать и добавить в индекс** to queue extraction into `imports/unreal-pak-v1/`. The job shows status, opens the report and links to the indexed files when available.

```sh
npm run cli -- package-inspect "/absolute/path/example.pak" --json
npm run cli -- package-import "/absolute/path/example.pak" --json
npm run cli -- package-import "/absolute/path/example.pak" --queue --json
```

The independent worker handles stored and Zlib-compressed entries from supported stock Pak layouts. Supported embedded FBX, GLB, PNG and WAV files retain their bytes. Valid loose Unreal packages and matching companions are saved to `Source/` with their archive-relative paths. The report records each result and source hash. Repeated imports reuse verified artifacts. The dedicated `unreal-extract` command remains available. Cooked object decoding, IoStore extraction, dependency resolution, new format conversion and folder watching for Pak remain pending.

Set `ASSET_VIEWER_UNITY` or `ASSET_VIEWER_BLENDER` to an absolute executable path. Set `ASSET_VIEWER_UNITY_ROOTS` or `ASSET_VIEWER_UNREAL_ROOTS` to absolute installation directories using the operating system's PATH separator. Start or restart the app with those settings.

## Generate model thumbnails

In an indexed GLB, glTF, binary VRM or polygonal OBJ card, click **Создать миниатюру**. Generation runs in the background and uses the model's base geometry and glTF base colors at 160 × 160 pixels. The renderer supports triangle meshes within its size and complexity limits. Texture maps, animation, skinning, morphs, sparse accessors and Draco or meshopt compression are outside its support. Use **Открыть во вьювере** for interactive inspection.

When a source or geometry buffer changes, scan the library again and request a new thumbnail. Use **Кэш миниатюр** in the index to view usage or clear generated images. The cache defaults to 64 MiB, with an inactivity limit of 30 days. Set `ASSET_VIEWER_THUMBNAIL_CACHE_BYTES` to a byte limit of at least 131072 before launching. Clearing the thumbnail cache leaves asset files and index metadata in place.

```sh
npm run cli -- preview <asset-id> --dry-run --json
npm run cli -- preview <asset-id> --json
npm run cli -- jobs --type thumbnail --json
npm run cli -- thumbnail-cache --clear --dry-run --json
```

The default CLI preview command waits for the PNG and prints its cache path. Use `--status` to query without submitting, or `--queue` to submit for the running browser server or desktop app.

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

On Windows, the database, backups and imports live under `%APPDATA%\AssetViewer`. Demo assets and cache data live under `%LOCALAPPDATA%\AssetViewer`. Other platforms use their application data and cache directories. `ASSET_VIEWER_DATA_DIR` overrides data paths with an absolute directory for source or desktop sessions. SQLite backups contain index data. Keep a separate copy of the import directory when backing up extracted files.

```sh
npm run cli -- doctor
npm run cli -- backup
node scripts/asset-viewer.mjs export > asset-metadata.json
```

If a database cannot open, keep the file and its SQLite sidecars for recovery. To try a backup, close Asset Viewer and copy the backup into a new isolated data directory as `index.sqlite`. Launch with `ASSET_VIEWER_DATA_DIR` set to that directory, check the data and run `doctor`. This is a manual recovery workflow.
