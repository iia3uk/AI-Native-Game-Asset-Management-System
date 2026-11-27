# Local API

The server binds to IPv4 loopback. Browser writes require the current origin and `Content-Type: application/json`. The legacy Fab and folder endpoints remain in place.

| Method | Route | Input and result |
| --- | --- | --- |
| GET | `/api/index/libraries` | Returns connected libraries with indexed file counts and the `watching` setting |
| POST | `/api/index/libraries` | `{"path":"<absolute local folder>"}` returns a durable library identity |
| POST | `/api/index/libraries/:id/watch` | `{"enabled":true}` or `{"enabled":false}` persists the setting and returns `{library}` |
| POST | `/api/index/libraries/:id/scan` | Empty object. Returns added, changed, moved, missing, hashed, reused and skipped hash counts |
| POST | `/api/index/libraries/:id/jobs` | Empty object. Returns 202 and the new or active scan job |
| GET | `/api/index/jobs` | Optional `library`, `limit` (1–200) and `offset`. Returns active jobs first |
| GET | `/api/index/jobs/:id` | Returns persisted status, file count, attempt count, `trigger` (`manual` or `watch`) and result or error |
| POST | `/api/index/jobs/:id/cancel` | Cancels a pending job or requests cancellation for a running job |
| POST | `/api/index/jobs/:id/retry` | Queues a failed, cancelled or interrupted job with fewer than three started attempts |
| POST | `/api/index/libraries/:id/disconnect` | Empty object. Hides the library and retains its records |
| GET | `/api/index/search` | `q`, `library`, `kind`, `limit` (1–100), `offset`. Returns `assets` and `nextOffset` |
| GET | `/api/index/duplicates` | `limit`, `offset`. Hash groups among available files in connected libraries |
| GET | `/api/index/assets/:id` | Indexed metadata and the latest 100 versions |
| POST | `/api/index/assets/:id` | Partial update of `category`, `tags`, `note`, `review` or `license` |
| POST | `/api/index/assets/:id/open` | Returns the legacy viewer folder session, group and file identity |
| POST | `/api/demo` | Creates and opens a separate procedural demo session on demand |

Failed scans preserve the last committed index. Disconnection and removal of original files retain history. Search excludes disconnected and missing assets.

Automatic scans use the same queue. An explicit scan request promotes the active automatic job to a manual job if the job is still available. Disabling watching cancels queued automatic jobs and requests cancellation for running automatic jobs.
