# Architecture

`server.mjs` is the loopback HTTP adapter. The browser renderer lives in `public/`, with the 3D stage separated from catalog UI and thumbnail scheduling. Legacy local grouping and Unity material resolution are currently in `scripts/`. Fab remains a separate file-backed source.

`core/` owns browser-independent access and discovery. The same format registry drives discovery and existing preview support. `AssetIndex` owns the SQLite registry, assets, version history, full-text search and review fields. `index-http.mjs` adapts core calls to the browser. The browser opens indexed search results in the existing renderer.

Asset roots are user-selected, canonical directories. Discovery skips child symlinks and junctions. File paths stay relative to their root until opened. Generated caches and database files belong to the application data directory, resolved by `core/data-paths.mjs`.

The SQLite job queue records scan progress and permits one active scan job per library. The HTTP process claims jobs using a renewable lease. The successful result and updated assets commit in the same transaction. Pending jobs resume after startup. An expired running job is marked interrupted and can be retried.

The CLI and stdio MCP interfaces call `AssetIndex` directly. The MCP connector opens the database read-only and applies a library scope to every query.

The Electron main process launches the loopback server in a UtilityProcess and injects an ephemeral authorization header in its dedicated browser session. The isolated renderer has a single folder-picker bridge. The desktop app prefers port 8178, permits a configured port, and can fall back to an ephemeral port. Indexed user metadata stays independent of the browser port.
