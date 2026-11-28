# User guide

## Preview an asset

Open **Демобиблиотека** to try the generated cabin, pine and rocks, and textured pennant. Select a group on the left and an asset on the right. Use the mouse to orbit and zoom. Toggle **Сетка** for wireframe or **Часть** to inspect a single part. The cabin has a **Turntable** clip available in the animation controls.

Use **Локальные папки** to open an existing folder without creating a database library. Use the existing **Fab** tab for an optional Fab catalog. For the full list of formats and texture overrides, see [README.ru.md](../README.ru.md).

## Connect and search a library

Open **Индекс**, choose or enter the absolute folder path, then click **Подключить и сканировать**. Filter by library and file type. Search accepts substrings in paths, names, formats, categories, tags, notes and license text.

Select a result to edit its metadata or click **Открыть во вьювере**. Use **Пересканировать** when a library changes. Disconnected libraries disappear from results. Reconnecting the same root restores its records. Originals remain in place.

Scans keep running if you close the index dialog. Open it and select the library to see progress or the last result. Use **Отменить сканирование** while a job is active. Use **Повторить задание** after a failure or interruption. Queued jobs persist across restarts.

## Import a Unity package

Open **Индекс → Импорт пакетов Unity и Unreal**. In the desktop app, select or drop up to 16 files. Use **Выбрать папку ресурсов…** for direct folder imports. In the browser, enter the full local path and click **Проанализировать**. Expand a package to see its contents, then choose **Обработать и добавить в индекс**. With multiple packages analyzed, **Обработать проанализированные пакеты** queues the remaining packages using settings supported by each format. The jobs list displays progress and offers cancellation or retry where available.

For one-time folder import, expand **Найти пакеты в папке** and choose the directory or enter its absolute path. Search checks nested files by header or trailer, including renamed files. A GZIP file is a Unity Package candidate until analysis checks its archive contents. Select files and click **Проанализировать выбранные**, then queue the analyzed packages. Each page contains up to 16 files. Queue a page before analyzing the next one. Use a smaller subfolder if the search reaches its limit of 500 candidates or 20,000 directory entries.

```sh
npm run cli -- package-folder "/absolute/path/incoming" --json
npm run cli -- package-folder "/absolute/path/incoming" --import --json
```

The CLI lists candidates by default. With `--import`, it analyzes, queues and indexes each successful package in sequence. You can add `--export fbx,glb`. The command prints a per-file result and exits with a failure code if it encounters an analysis, import or indexing error. Both folder workflows leave automatic watching settings intact.

In the desktop app, open **Обработка папки UE / Unity** and select a source folder. A common export folder is optional. **Обработать папку и предложить очистку** imports with the selected conversion settings and indexes the results. If you selected an export folder, each package has a subfolder containing converted files, directly usable textures, models and audio, and a manifest linking them to the original import. Cleanup for a package with an export destination is offered after its verified copy finishes.

The native dialog shows the eligible files and their total size. **Больше не спрашивать** applies to later cleanup requests for that engine. **Включить подтверждения очистки** restores prompts for both engines. **Исходники в корзину…** in a completed job report invokes the same cleanup.

Use **Приостановить** in an import job row to hold a queued package or stop the current conversion. **Продолжить** starts that package again with the same settings after it reaches **На паузе**. The pause survives restart. During the folder workflow, the current session waits for the paused package before exporting its result or offering cleanup. The CLI actions `jobs <job-id> --pause` and `jobs <job-id> --resume` update the same queue used by the running app.

Cleanup moves eligible files to the operating system's recycle bin. Individual engine assets require a verified converted file and a managed source copy, which stays in application data. Archive and binary container cleanup verifies the published files. Auxiliary engine files, project descriptors and unsupported loose resources stay in their source folders. For an export that includes the managed engine sources, use **Экспортировать в папку** in the package report.

Use **Показать в индексе** after the scan completes. Supported originals such as FBX, GLB and PNG retain their original bytes and `Assets/` or `Packages/` paths. The application copies them into its data directory and uses the existing viewer. The report shows unavailable and excluded entries.

**Без Unity** is the default mode. **Авто** and **С Unity Editor** also allow an installed Unity 6000 final or patch release to export supported native objects. Enter a preferred Editor version or leave it blank to use a detected installation. Both modes use the direct pipeline for supported originals. The first Editor run may download the pinned FBX Exporter and its dependencies from the Unity registry. The job keeps the original assets and reports any Editor or per-asset export issue.

The job result shows the managed output directory. **Отчёт об импорте → Показать файлы** lists the result for each asset and model format. The original tree lives in `Source/`. With a format selected, the export also contains `Models/`, `Textures/`, `Materials/`, `Animations/`, `Audio/`, `Previews/` and `Metadata/`. Original FBX and GLB files can be copied directly. Blender 4.5 or newer can produce FBX and GLB derivatives from OBJ, glTF, GLB and binary FBX. Original textures are copied byte for byte. An FBX copied from the package can still need its external textures relinked. Individual conversion failures appear in the report and other assets continue.

The Unity bridge exports whole prefabs and their mesh renderers as individual FBX files, standalone transform animations as FBX, supported readable textures as PNG and material texture bindings as JSON. GLB previews of Unity geometry use Blender. Unity scenes, binary Unity assets, assets with custom serialized components and shader graphs remain source files or diagnostic entries.

The reports are `manifest.json`, `dependencies.json` and `conversion-report.json`. They record source paths, GUIDs, available file IDs, hashes, dependency status and how each artifact was made. An unchanged archive with the same mode, formats and tool installations reuses verified output. Fab package import remains pending.

```sh
npm run cli -- package-inspect "/absolute/path/example.unitypackage" --json
npm run cli -- package-import "/absolute/path/example.unitypackage" --dry-run --json
npm run cli -- package-import "/absolute/path/example.unitypackage" --json
npm run cli -- package-import "/absolute/path/example.unitypackage" --export fbx,glb --json
npm run cli -- package-import "/absolute/path/example.unitypackage" --mode engine-assisted --unity-version 6000.3.10f1 --export fbx,glb --json
npm run cli -- jobs --type package-import --json
```

The default CLI command waits for extraction and indexing. Add `--queue` to hand processing to the running desktop app or loopback server.

## Import a Unity project or local UPM package

In **Импорт пакетов Unity и Unreal**, click **Выбрать папку ресурсов…** or paste the absolute folder path. Use the project root that contains `Assets` and `ProjectSettings`, or the package root that contains `package.json`. Analyze the folder and click **Обработать и добавить в индекс**. The report includes the project's Unity version, included UPM packages, original paths and resolved GUID links. The input folder stays read-only.

Project import includes embedded packages and local folder dependencies contained in the project. Registry packages, project caches, external dependencies and UPM tarballs are outside this workflow. Select a separate local UPM folder directly to import it. For optional Editor conversion, the importer uses the project's declared Unity version when you leave the version field blank. [Unity package manifests](https://docs.unity.com/en-us/engine/6000.0/manual/packages-list/cus-pkg-development/upm-manifest-pkg).

```sh
npm run cli -- package-inspect "/absolute/path/MyUnityProject" --json
npm run cli -- package-import "/absolute/path/com.example.assets" --export fbx,glb --json
```

## Save completed imports to a folder

In **Отчёт об импорте**, open **Экспортировать в папку** for the whole package. For one resource, click **Показать файлы** and use **Выбрать для экспорта** on its row. Choose an existing destination outside connected libraries. Click **Составить план** to review files, size and known missing links. **Экспортировать** creates a new subdirectory with the artifacts and three reports. A single-resource export includes known linked resources with their relative paths. UnityFS and Pak reports show when dependency coverage is limited.

The CLI returns a plan by default. Add `--asset <offset>` for a resource's zero-based position in the manifest. Use the same arguments with `--plan-key` followed by the returned key to publish the export.

```sh
npm run cli -- package-export <job-id> "/absolute/existing/output" --json
npm run cli -- package-export <job-id> "/absolute/existing/output" --plan-key <key> --json
```

## Inspect and import a Unity AssetBundle

The importer recognizes stock UnityFS by its file signature. Select or drop a bundle in **Импорт пакетов Unity и Unreal**, or enter its path and click **Проанализировать**. Expand the result for the container version, Unity version and serialized object IDs. **Обработать и добавить в индекс** queues PNG, GLB and WAV output for supported objects. Select **FBX** to request an additional Blender export. UnityFS always uses the independent decoder, including when it is submitted with `.unitypackage` files configured to use Unity Editor.

The Windows app includes the decoder. For source runs, follow the [worker build instructions](BUILD.md). The same interface is available in the CLI:

```sh
npm run cli -- package-inspect "/absolute/path/example.bundle" --json
npm run cli -- package-import "/absolute/path/example.bundle" --json
npm run cli -- package-import "/absolute/path/example.bundle" --export fbx --queue --json
```

Inspection lists the archive and Unity versions and up to 500 serialized objects with their IDs and support status. The worker handles stored and LZ4 blocks. It reads embedded type trees and publishes the highest-resolution mip of supported RGBA32, DXT1 and DXT5 textures as PNG. Texture data can be inline or in a matching `.resS` member inside the same archive. External resource files, other texture encodings and textures larger than 2048 × 2048 are outside this path. The worker exports supported static triangle meshes as GLB with positions, normals, UV0 and separate submeshes. If Blender is unavailable, the GLB and PNG still reach the index.

Unpacked sprites with an integer pixel rectangle and a supported base texture in the same serialized member produce individual `Sprite-*.png` files. Multiple sprites can come from one sheet. Their PNGs keep the source transparency, and the report records each rectangle and texture reference. Packed atlases, separate alpha textures and cross-member sprite references are reported as unsupported. [Unity Sprite API](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Sprite.html).

Mono and stereo AudioClips with 16-bit PCM in a single-sound FSB5 bank produce WAV files with the same sample values and sample rate. Open a WAV result from the index with **Открыть во вьюере** to play it. Export supports an embedded `.resource` entry and a maximum WAV size of 32 MiB. Vorbis, other codecs and external resource references are reported individually. [Unity audio import settings](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/AudioImporterSampleSettings.html).

The report marks unsupported layouts and classes. Meshes with skinning, blend shapes, mesh compression, extra vertex attributes or multiple vertex streams are outside the current decoder. Additional pixel formats, material bindings and bundle dependency analysis remain pending. A repeated import with the same SHA-256, output formats and tool versions reuses verified results.

## Import a standalone binary Unity file

Select a binary `.asset` or `.assets` file in the same importer, or find it with **Найти пакеты в папке**. The decoder reads little-endian formats 22 and 23. With embedded type trees, supported static meshes become GLB with optional FBX. Supported RGBA32, DXT1 and DXT5 textures become PNG and 16-bit PCM AudioClips become WAV. Files with the type trees removed can export those textures and audio from verified Windows Player builds from Unity 6000.3.10f1 and 6000.6.0f1. Missing schemas and unsupported objects appear in the report.

Keep the original filenames. For example, put `resources.assets`, `resources.assets.resS` and `resources.resource` in the same directory and select `resources.assets`. Inspection lists the matching files. Each companion can be up to 256 MiB, with a 512 MiB total. If a companion changes while the import is pending, run inspection again. Text-based Unity YAML files continue to be handled by the Unity package importer.

```sh
npm run cli -- package-inspect "/absolute/path/mesh.asset" --json
npm run cli -- package-import "/absolute/path/mesh.asset" --export fbx --json
```

## Automatically import packages from a folder

Open **Индекс**, connect the incoming folder, select it under **Библиотека**, then expand **Автоимпорт пакетов** and enable the formats you want. The app checks existing files and new or changed files in subfolders while it is running. It confirms the format from the contents before extracting anything. Results are indexed in managed libraries, and progress and reports appear in **Импорт пакетов Unity и Unreal**.

- **.unitypackage** extracts the originals and requests FBX and GLB for supported models.
- **UnityFS** watches `.bundle` and `.unity3d`, decodes supported textures, sprites, static meshes and audio, and requests FBX where Blender is available.
- **Бинарные Unity** watches `.asset`, `.assets` and `.sharedAssets` with a supported binary header. Keep the primary file and its matching `.resS` and `.resource` files together. A new or changed companion queues a new import, even when the primary file stays the same. The switch applies to binary files and leaves Unity YAML assets out of the queue.
- **Unreal Pak** watches `.pak` and extracts supported original files using the independent CUE4Parse worker.

Turning off a format cancels its active automatic imports for that folder. The settings and SHA-256 history survive restarts. Use **Повторить** in a job row to retry a failed, interrupted or cancelled import. For a renamed archive, use manual inspection to detect the format by contents.

```sh
npm run cli -- libraries --json
npm run cli -- watch-packages <library-id> on --json
npm run cli -- watch-packages <library-id> on --format unityfs --json
npm run cli -- watch-packages <library-id> on --format unity-serialized --json
npm run cli -- watch-packages <library-id> on --format unreal-pak --json
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

Select an Unreal project root, a `.uproject` file, an asset folder or a loose `.uasset` or `.umap`. If a project root has several descriptors, select the matching `.uproject`. The default mode, **Без редактора**, copies eligible packages and their matching sidecars to `Source/Content`, records checksums and adds supported file types to the index. Recognized cooked and unversioned assets are preserved as original bytes. Use the job report to export a whole import or one package with its sidecars. [Unreal project directory structure](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-directory-structure).

Supported UE4 editor assets can yield the original PCM WAV or source PNG without an editor. Their output appears under `Audio/` and `Textures/`. Texture extraction skips package thumbnails. The report includes the count and file metadata for each recovered format.

**Без редактора** also extracts the source geometry and material slots from supported UE4 StaticMesh packages with package version 522 and editor object version 40. It saves glTF/BIN pairs for the LODs with serialized geometry and reports LODs that require an Unreal build. The original mesh conversion preserves the first UV channel, supported vertex colors and valid source normals and tangents. Select **FBX** or **GLB** for additional outputs through a locally installed Blender. Source cleanup verifies both files of each glTF/BIN pair before offering to recycle the source.

Set `ASSET_VIEWER_UE_VIEWER` to the absolute path of a trusted local UE Viewer executable, build 1590 or later, before launching Asset Viewer or its CLI to decode additional supported UE4 meshes and animation clips. The exported ActorX PSA clips need a compatible skeleton. [UE Viewer](https://www.gildor.org/en/projects/umodel).

The importer recovers material instance parameters, parent references and texture streaming data directly from supported stock UE4 editor packages. It saves those properties under `Materials/`. With UE Viewer configured, it also uses that tool's material dumps where available. When a model slot identifies one material and an explicit map matches the available texture evidence, an additional `*-materials.gltf` links supported base color, emissive, normal and packed surface textures on UV0. Direct tangent-space normal maps account for the texture's Unreal import flag and generate an OpenGL PNG if its green channel needs inversion. Explicit ORM maps use the original PNG. Explicit RMA and MRA maps in supported 8-bit RGB or RGBA PNGs get a separate ORM PNG at the original resolution. Blender prefers the textured variant for FBX and GLB. Exporting an individual mesh includes the linked materials and textures. [Unreal texture masks](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-texture-masks-in-unreal-engine). [glTF 2.0 material channels](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).

Supported UE4 cutouts such as grass and foliage retain their mask, clipping threshold and double-sided setting in glTF and GLB. A mask can come from a texture's alpha channel or a separate grayscale PNG. When a supported color source is unavailable, the cutout uses neutral color and the import report records that limitation. Translucent materials, custom shader operations and collisions still require separate handling. [Unreal opacity masks](https://dev.epicgames.com/documentation/unreal-engine/material-inputs?application_version=4.27).

For a trusted project or Content folder, choose **С редактором** or **Авто** to request native conversion. Specify **Версия Unreal** when you want a particular installed version. With an available editor, FBX output can also produce GLB previews if Blender is installed. The job retains its direct copies if the editor is unavailable.

```sh
npm run cli -- package-import "/absolute/path/Project.uproject" --json
npm run cli -- package-import "/absolute/path/Content" --export fbx,glb --json
npm run cli -- package-import "/absolute/path/Project.uproject" --mode engine-assisted --unreal-version 5.7 --export fbx,glb --json
```

Use `unreal-inspect` with a `.uproject`, its `Content` folder or an individual Unreal file. The inspection classifies supported loose package headers as editor, cooked, unversioned or unknown, recognizes standard Pak and IoStore headers and lists companion files. Project inspection reads up to 30,000 directory entries and returns counts and the first 500 matches. The command does not require Unreal Editor.

```sh
npm run cli -- unreal-inspect "/absolute/path/Project.uproject" --json
npm run cli -- unreal-export "/absolute/path/Project.uproject" --unreal-version 5.7 --json
```

`unreal-export` is an opt-in CLI preview for trusted editor content. Select a `.uproject` or a `Content` folder. It needs a locally discovered Unreal Editor 5.1 or newer and selects the associated build when available. For a folder without an association, it can use the latest compatible detected Editor. You can override the version. The temporary project uses bundled Python and only stages eligible assets under `/Game`. It reports missing dependencies and unsupported resources.

The bridge requests FBX for static meshes, skeletal meshes and animation sequences, PNG for supported textures and WAV for audio. Materials and standalone skeletons produce JSON metadata. Verified outputs publish under the app's managed import folder and discoverable files are added to the shared index. The manifest records source paths and hashes. The Editor bridge still needs end-to-end validation with a native Unreal installation.

Use **Индекс → Импорт пакетов Unity и Unreal** to inspect a stock Pak with a supported unencrypted index. Select a file or drop it into the importer. Inspection lists up to 500 entries. Click **Обработать и добавить в индекс** to queue extraction into `imports/unreal-pak-v1/`. The job shows status, opens the report and links to the indexed files when available.

The Windows installer and portable app include the Pak decoder. For the CLI from source, build the worker once. [Build instructions](BUILD.md).

```sh
npm run cli -- package-inspect "/absolute/path/example.pak" --json
npm run cli -- package-import "/absolute/path/example.pak" --json
npm run cli -- package-import "/absolute/path/example.pak" --queue --json
```

The independent worker handles stored and Zlib-compressed entries from supported stock Pak layouts. Supported embedded FBX, GLB, PNG and WAV files retain their bytes. Valid loose Unreal packages and matching companions are saved to `Source/` with their archive-relative paths. The report records each result and source hash. Repeated imports reuse verified artifacts. The dedicated `unreal-extract` command and Pak folder watching are also available. Cooked object decoding and IoStore extraction remain pending.

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
