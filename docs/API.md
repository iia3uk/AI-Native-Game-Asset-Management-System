# Local API

The server binds to IPv4 loopback. Browser writes require the current origin and `Content-Type: application/json`. The legacy Fab and folder endpoints remain in place.

| Method | Route | Input and result |
| --- | --- | --- |
| GET | `/api/index/libraries` | Returns connected libraries with indexed file counts, `watching`, `packageWatchFormats` and the `.unitypackage` compatibility flag `packageWatching` |
| POST | `/api/index/libraries` | `{"path":"<absolute local folder>"}` returns a durable library identity |
| POST | `/api/index/libraries/:id/watch` | `{"enabled":true}` or `{"enabled":false}` persists the setting and returns `{library}` |
| POST | `/api/index/libraries/:id/package-watch` | `{"enabled":true,"format":"unityfs"}` enables or disables one format and returns `{library}`. Formats are `unitypackage` (default), `unityfs` and `unreal-pak` |
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
| POST | `/api/index/packages/inspect` | An absolute file `path` or a folder result's `root` and relative `path`. Returns the detected format, SHA-256, entry count and up to 500 preview entries |
| POST | `/api/index/packages/import` | Send the same absolute `path` or folder `root` and relative `path` as for inspection, along with the inspection `hash` and optional `formats` such as `["fbx","glb"]`. Returns 202 and the new or active import job. The default mode `engineless` extracts originals when formats are omitted. Optional `mode` values `auto` and `engine-assisted` allow Unity for native objects and default to both formats. Optional `editorVersion` specifies the preferred Unity version in these modes |
| GET | `/api/index/jobs/:id/manifest?limit=50&offset=0` | Lists a completed package's assets with per-format output statuses, relative paths, method and hashes. Returns `assets`, `total` and `nextOffset`. The maximum limit is 100 |
| GET | `/api/index/engines` | Lists detected Unity, Unreal and Blender executables and available version metadata without starting an editor |
| POST | `/api/demo` | Creates and opens a separate procedural demo session on demand |

For a UnityFS container, package inspection returns `format: "unityfs"`, `containerVersion`, `unityVersion`, `hash`, `total` and up to 500 serialized objects in `assets`. Use the same import route with the inspection hash. UnityFS jobs always decode supported textures to PNG and meshes to GLB. Request `"fbx"` in `formats` for an additional Blender export. The UnityFS result has `report.packageFormat: "unityfs"`. The manifest exposes serialized member names, object path IDs and per-format results.

For a Pak archive, inspection returns `format: "unreal-pak"`, `containerVersion`, `hash`, `total` and up to 500 entries in `assets`. Import accepts `auto` or `engineless` with no export formats or editor version. Pak jobs extract supported originals and report `report.packageFormat: "unreal-pak"`. The manifest page includes archive paths, extracted file hashes and reasons for skipped entries.

Failed scans preserve the last committed index. Disconnection and removal of original files retain history. Search excludes disconnected and missing assets.

Automatic scans use the same queue. An explicit scan request promotes the active automatic job to a manual job if the job is still available. Turning off folder watching and all automatic import formats cancels queued automatic scans and requests cancellation for a running automatic scan.

Automatic archive imports have `type: "package-import"` and `trigger: "watch"`. An identical explicit import promotes the active job to manual priority. Turning off a format cancels queued automatic imports and requests cancellation of a running automatic import for that format in the source library. An unchanged failed or cancelled archive remains in job history for an explicit retry.

The package import result contains `directory`, `report`, `reused`, `library` and `scanJobId`. Check the scan job for indexing completion. `library` and `scanJobId` are null when all items were excluded. The package path is used locally and the job list exposes its basename. With Unity allowed, `report.export.unity` records the Editor outcome and available versions. Per-file export entries distinguish prefab, component, mesh, animation, texture and material roles.

Thumbnail requests deduplicate active jobs for the same asset version. The thumbnail route reports `available`, `missing`, `stale`, `unsupported`, `unavailable`, `limited`, or a job status. A stale source requires a new scan. The image route returns 404 when the asset, cache entry or source version is no longer available. Queued or running jobs can populate the cache after a clear.

Analysis reports contain `status`, `metrics`, `issues`, `dependencies` and `dependenciesTruncated`. Unknown metrics use `null` or are omitted when the metric does not apply. Dependencies return a role, status, library-relative path when applicable, optional `targetId`, `via` material-library path and available image dimensions. The report includes up to 128 dependency entries. An `unavailable` dependency has a recognized local path with no live row in the same library. An `unindexed` dependency has a path outside the indexed format registry.

Validation returns the chosen profile and revision, the overall status, and `checks` with a key, limit, measured or observed value, reason code and optional library-relative evidence path. Status values are `pass`, `fail`, `unknown` and `not-applicable`. A failure takes precedence over unknown checks. A result is `pass` when at least one check applies and every applicable check passes. Omit a limit or a boolean check to disable it. The limits object replaces the full profile configuration.
