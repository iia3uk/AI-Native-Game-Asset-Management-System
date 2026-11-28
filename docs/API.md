# Local API

The server binds to IPv4 loopback. Browser writes require the current origin and `Content-Type: application/json`. The legacy Fab and folder endpoints remain in place.

| Method | Route | Input and result |
| --- | --- | --- |
| GET | `/api/index/libraries` | Returns connected libraries with indexed file counts, `watching`, `packageWatchFormats` and the `.unitypackage` compatibility flag `packageWatching` |
| POST | `/api/index/libraries` | `{"path":"<absolute local folder>"}` returns a durable library identity |
| POST | `/api/index/libraries/:id/watch` | `{"enabled":true}` or `{"enabled":false}` persists the setting and returns `{library}` |
| POST | `/api/index/libraries/:id/package-watch` | `{"enabled":true,"format":"unityfs"}` enables or disables one format and returns `{library}`. Formats are `unitypackage` (default), `unityfs`, `unity-serialized` and `unreal-pak` |
| POST | `/api/index/libraries/:id/scan` | Empty object. Returns added, changed, moved, missing, hashed, reused and skipped hash counts |
| POST | `/api/index/libraries/:id/jobs` | Empty object. Returns 202 and the new or active scan job |
| GET | `/api/index/jobs` | Optional `library`, `type` (`scan`, `thumbnail`, or `package-import`), `limit` (1–200) and `offset`. Returns active jobs first |
| GET | `/api/index/jobs/:id` | Persisted status, progress, attempts, trigger and result or error. Progress counts files for scans and reports a percentage for thumbnails and imports |
| POST | `/api/index/jobs/:id/cancel` | Cancels a pending job or requests cancellation for a running job |
| POST | `/api/index/jobs/:id/retry` | Queues a failed, cancelled or interrupted job with fewer than three started attempts |
| POST | `/api/index/libraries/:id/disconnect` | Empty object. Hides the library and retains its records |
| GET | `/api/index/search` | `q`, `library`, `kind`, `limit` (1–100), `offset`. Returns `assets` and `nextOffset` |
| GET | `/api/index/duplicates` | `limit`, `offset`. Hash groups among available files in connected libraries |
| GET | `/api/index/assets/:id` | Returns `asset`, the latest 100 `versions` and `analysis`. Optional `profile` adds a `validation` report |
| POST | `/api/index/assets/:id` | Partial update of `category`, `tags`, `note`, `review` or `license` |
| POST | `/api/index/assets/:id/open` | Returns the legacy viewer folder session, group and file identity |
| GET | `/api/index/assets/:id/thumbnail` | Thumbnail status, active or recent job when applicable, or PNG URL and byte size when available |
| POST | `/api/index/assets/:id/thumbnail` | Empty object. Queues generation if applicable. Returns 202 with the new or active job, or 200 with the current thumbnail status |
| GET | `/api/index/assets/:id/thumbnail-image?v=<key>` | Returns a cached PNG when the key still matches the current source and the geometry buffers |
| GET | `/api/index/thumbnail-cache` | Returns `entries`, `bytes` and the configured byte `limit` |
| POST | `/api/index/thumbnail-cache/clear` | Empty object. Removes generated thumbnails and returns cache usage |
| GET | `/api/index/quality-profiles` | Returns the six saved or default profiles and the supported field definitions |
| POST | `/api/index/quality-profiles/:id` | `{"revision":0,"limits":{"maxTriangles":12000}}` replaces the enabled limits. `{"revision":0,"reset":true}` restores defaults. Stale revisions return 409 |
| POST | `/api/index/packages/folder` | `{"path":"<absolute local folder>"}` returns its canonical `root`, detected `packages` with relative `path` and `format`, plus `visited`, `skipped` and `truncated` |
| POST | `/api/index/packages/inspect` | An absolute `path` to a file, Unity project or UPM folder, or a folder search result's `root` and relative `path`. Returns the detected format, SHA-256, entry count and up to 500 preview entries |
| POST | `/api/index/packages/import` | Send the same absolute `path` or folder `root` and relative `path` as for inspection, along with the inspection `hash` and optional `formats` such as `["fbx","glb"]`. Returns 202 and the new or active import job. The default mode `engineless` extracts originals when formats are omitted. Optional `mode` values `auto` and `engine-assisted` allow Unity for native objects and default to both formats. Optional `editorVersion` specifies the preferred Unity version in these modes |
| GET | `/api/index/jobs/:id/manifest?limit=50&offset=0` | Lists a completed package's assets with per-format output statuses, relative paths, method and hashes. Returns `assets`, `total` and `nextOffset`. The maximum limit is 100 |
| POST | `/api/index/jobs/:id/export-plan` | `{"destination":"<absolute local folder>"}` previews a whole package export. Optional `asset` selects one item by zero-based manifest offset |
| POST | `/api/index/jobs/:id/export` | Send the same destination and selection with the plan's `key`. Returns 201 and the new `directory` |
| GET | `/api/index/engines` | Lists detected Unity, Unreal and Blender executables and available version metadata without starting an editor |
| POST | `/api/demo` | Creates and opens a separate procedural demo session on demand |

For Unity folders, inspection returns `format` as `unity-project` or `unity-upm`, the declared project `engineVersion` when available and a `packages` list with local UPM names and versions. Send the same absolute path and inspection hash to queue the job. The manifest retains normalized resource paths, GUIDs and the engine version. Jobs using an Editor default to the declared project version when present.

For a UnityFS container, package inspection returns `format: "unityfs"`, `containerVersion`, `unityVersion`, `decoderRevision`, `hash`, `total` and up to 500 serialized objects in `assets`. Use the same import route with the inspection hash. UnityFS jobs decode supported textures to PNG and meshes to GLB. Request `"fbx"` in `formats` for an additional Blender export. The UnityFS result has `report.packageFormat: "unityfs"`. The manifest exposes serialized member names, object path IDs and per-format results. Supported textures include `textureEncoding` (`rgba32`, `dxt1` or `dxt5`) and `textureStorage` (`inline` or `bundle-member`).

For a standalone little-endian Unity serialized file, inspection returns `format: "unity-serialized"` and `containerVersion` (22 or 23) with the same object fields. Import uses the inspection hash and reports `packageFormat: "unity-serialized"`. The manifest records `assetstools-unity-serialized` as the import method and uses `input.assets` as the object member identifier. A texture from a sibling file reports `textureStorage: "companion"`. When companion files are present, inspection returns `resources` with each file's name, role, size and SHA-256. The manifest records the same list at `source.resources` and the primary file's SHA-256 at `source.contentsSha256`. The inspection hash and `source.sha256` cover the primary file and the companion list together. Without companions, both use the primary file's SHA-256.

Supported UnityFS sprites have class ID 213 and publish individual PNGs. Inspection and manifest entries include `width`, `height` and `sprite: { texturePathId, x, y }`. The texture path ID refers to a Texture2D in the same serialized member. The coordinates are integer pixels from the lower left of the texture, and the PNG stores rows from the top. The dependency report lists verified `sprite-texture` links and marks coverage as partial.

Supported UnityFS audio clips have class ID 83 and publish 16-bit PCM WAV files under `Audio/`. Inspection and manifest entries include `audio: { channels, sampleRate, frames }`. The artifact method is `assetstools-unityfs-fsb5-pcm16`. Indexed WAV files can be opened using the existing asset viewer route and served with byte ranges.

For a Pak archive, inspection returns `format: "unreal-pak"`, `containerVersion`, `hash`, `total` and up to 500 entries in `assets`. Import accepts `auto` or `engineless` with no export formats or editor version. Pak jobs extract supported originals and report `report.packageFormat: "unreal-pak"`. The manifest page includes archive paths, extracted file hashes and reasons for skipped entries.

For a loose Unreal source, inspection returns `unreal-project`, `unreal-content` or `unreal-asset`, with a fingerprint covering supported originals and their companions, up to 500 assets and the project association when present. Pass the same path and hash to queue the import. A project or asset folder accepts optional `mode: "auto"` or `"engine-assisted"` and `editorVersion` for an installed version or registered build. Standalone assets use `engineless`. The conversion report records the editor outcome in `report.unreal` when editor use was requested. The report includes `media.png` and `media.wav` counts for UE4 source media exported directly. Texture artifacts report their dimensions and PCM audio artifacts report channel count, sample rate, bit depth and frame count. The dependency document links copied primary packages and their sidecars in both directions.

Loose Unreal imports accept `exportFormats` containing `fbx` and `glb` in `engineless` mode. A configured UE Viewer emits glTF with BIN data and standalone PSA for supported UE4 assets. Blender provides the requested FBX and GLB derivatives from the extracted models. `report.unrealViewer` records converter availability or outcome, output counts, invalid artifacts and any phase errors. The manifest links each artifact to its source package.

`report.unrealViewer.materials` counts material JSON files, PNG files decoded by UE Viewer and separate textured glTF variants. `packedMaterials` counts resolved packed texture bindings and `repackedMaps` counts distinct generated ORM images. Material JSON records parameter names, source package paths, color-space assumptions and unresolved texture references. When present, `packedMap` records its source image, source layout and resolved channel mapping or a failure reason. Mesh export resolves `unreal-model-material`, `unreal-material-parent` and `unreal-material-texture` links in the package dependency report.

Failed scans preserve the last committed index. Disconnection and removal of original files retain history. Search excludes disconnected and missing assets.

Whole-package export plans accept `processedOnly: true` to copy derived artifacts and portable originals while omitting native Unity and Unreal source files. Send the same flag with the plan key to publish the result. Its manifest records `export.processedOnly`, the original job ID and source provenance.

Automatic scans use the same queue. An explicit scan request promotes the active automatic job to a manual job if the job is still available. Turning off folder watching and all automatic import formats cancels queued automatic scans and requests cancellation for a running automatic scan.

Automatic archive imports have `type: "package-import"` and `trigger: "watch"`. An identical explicit import promotes the active job to manual priority. Turning off a format cancels queued automatic imports and requests cancellation of a running automatic import for that format in the source library. An unchanged failed or cancelled archive remains in job history for an explicit retry.

The package import result contains `directory`, `report`, `reused`, `library` and `scanJobId`. Check the scan job for indexing completion. `library` and `scanJobId` are null when all items were excluded. The package path is used locally and the job list exposes its basename. With Unity allowed, `report.export.unity` records the Editor outcome and available versions. Per-file export entries distinguish prefab, component, mesh, animation, texture and material roles.

Export plans contain the resolved `destination`, output name `prefix`, `scope`, totals for `assets`, `files` and `bytes`, and the first 100 relative `paths`. Selection plans report the number of known `unresolved` links. `dependencyStatus` is included when the underlying importer marks its dependency coverage. A stale plan or an artifact that fails verification returns 409. An unavailable import returns 404.

Thumbnail requests deduplicate active jobs for the same asset version. The thumbnail route reports `available`, `missing`, `stale`, `unsupported`, `unavailable`, `limited`, or a job status. A stale source requires a new scan. The image route returns 404 when the asset, cache entry or source version is no longer available. Queued or running jobs can populate the cache after a clear.

Analysis reports contain `status`, `metrics`, `issues`, `dependencies` and `dependenciesTruncated`. Unknown metrics use `null` or are omitted when the metric does not apply. Dependencies return a role, status, library-relative path when applicable, optional `targetId`, `via` material-library path and available image dimensions. The report includes up to 128 dependency entries. An `unavailable` dependency has a recognized local path with no live row in the same library. An `unindexed` dependency has a path outside the indexed format registry.

Validation returns the chosen profile and revision, the overall status, and `checks` with a key, limit, measured or observed value, reason code and optional library-relative evidence path. Status values are `pass`, `fail`, `unknown` and `not-applicable`. A failure takes precedence over unknown checks. A result is `pass` when at least one check applies and every applicable check passes. Omit a limit or a boolean check to disable it. The limits object replaces the full profile configuration.
