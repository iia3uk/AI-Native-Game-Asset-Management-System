# Architecture

`server.mjs` is the loopback HTTP adapter. The browser renderer lives in `public/`, with the 3D stage separated from catalog UI and thumbnail scheduling. Legacy local grouping and Unity material resolution are currently in `scripts/`. Fab remains a separate file-backed source.

`core/` owns browser-independent access and discovery. The same format registry drives discovery and existing preview support. `AssetIndex` owns the SQLite registry, assets, version history, full-text search and review fields. `index-http.mjs` adapts core calls to the browser. The browser opens indexed search results in the existing renderer.

Asset roots are user-selected, canonical directories. Discovery skips child symlinks and junctions. File paths stay relative to their root until opened. Generated caches and database files belong to the application data directory, resolved by `core/data-paths.mjs`.

The SQLite job queue records scan progress and permits one active scan job per library. The HTTP process claims jobs using a renewable lease. The successful result and updated assets commit in the same transaction. Pending jobs resume after startup. An expired running job is marked interrupted and can be retried.

`LibraryWatcher` registers native recursive notifications for roots with an explicit SQLite opt-in. It groups nearby events into incremental scan jobs and retains changes received during a running scan for a follow-up. It reconciles at startup, when an unavailable root returns, and every 15 minutes. Reconciliation also covers filesystems without usable native notifications. Automatic jobs run at a lower queue priority than manual jobs and share the same discovery and path checks.

The scan reads bounded glTF/GLB/VRM and Wavefront OBJ/MTL data and supported image headers outside the SQLite transaction. It reuses existing analysis when the processor version, path and content still match. Technical metrics and explicit dependency rows commit with the asset updates and scan result. Dependencies resolve within the same library's committed index. OBJ texture links resolve one step through indexed material libraries, so changing a texture or MTL updates the next report without rewriting the OBJ.

Quality validation uses the current index report and the selected profile on demand. Profile edits use optimistic revisions and store their overrides in the same SQLite database, including backups. Evaluation is shared across interfaces and requires no extra scan.

Thumbnail generation uses the SQLite jobs table and a dedicated worker slot, so scans and previews can run concurrently. A lease and a unique index cap rendering at one running thumbnail job per database across the HTTP server and CLI. Pending work survives restarts. The renderer uses the pinned Three.js geometry loaders and a bounded software rasterizer in a terminable Node worker. The source and indexed geometry buffers must match their recorded file fingerprints and SHA-256 hashes. Publication checks the lease and source version and atomically renames the PNG from a staging file.

Generated 160 × 160 PNGs live in an application-owned directory shared by the HTTP server and CLI. The key includes content hashes, relative geometry buffer references, processor version, format and resolution. Thumbnail retrieval verifies current indexed inputs before serving output. A 64 MiB default quota evicts the least recently used files, and entries expire after 30 days without an HTTP image read. The cache is disposable and separate from database backups.

The CLI and stdio MCP interfaces call `AssetIndex` directly. The MCP connector opens the database read-only and applies a library scope to every asset query.

The Electron main process launches the loopback server in a UtilityProcess and injects an ephemeral authorization header in its dedicated browser session. The isolated renderer has a single folder-picker bridge. The desktop app prefers port 8178, permits a configured port, and can fall back to an ephemeral port. Indexed user metadata stays independent of the browser port.
