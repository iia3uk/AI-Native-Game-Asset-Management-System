# Local API

The server binds to IPv4 loopback. Browser writes require the current origin and `Content-Type: application/json`. The legacy Fab and folder endpoints remain in place.

| Method | Route | Input and result |
| --- | --- | --- |
| GET | `/api/index/libraries` | Returns connected libraries and indexed file counts |
| POST | `/api/index/libraries` | `{"path":"<absolute local folder>"}` returns a durable library identity |
| POST | `/api/index/libraries/:id/scan` | Empty object. Returns added, changed, moved, missing, hashed, reused and skipped hash counts |
| POST | `/api/index/libraries/:id/disconnect` | Empty object. Hides the library and retains its records |
| GET | `/api/index/search` | `q`, `library`, `kind`, `limit` (1–100), `offset`. Returns `assets` and `nextOffset` |
| GET | `/api/index/duplicates` | `limit`, `offset`. Hash groups among available files in connected libraries |
| GET | `/api/index/assets/:id` | Indexed metadata and the latest 100 versions |
| POST | `/api/index/assets/:id` | Partial update of `category`, `tags`, `note`, `review` or `license` |
| POST | `/api/index/assets/:id/open` | Returns the legacy viewer folder session, group and file identity |
| POST | `/api/demo` | Creates and opens a separate procedural demo session on demand |

Failed scans preserve the last committed index. Disconnection and removal of original files retain history. Search excludes disconnected and missing assets.
