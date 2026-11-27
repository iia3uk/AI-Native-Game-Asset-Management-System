# Architecture

`server.mjs` is the loopback HTTP adapter. The browser renderer lives in `public/`, with the 3D stage separated from catalog UI and thumbnail scheduling. Legacy local grouping and Unity material resolution are currently in `scripts/`. Fab remains a separate file-backed source.

`core/` owns browser-independent access and discovery. The same format registry drives discovery and existing preview support. `AssetIndex` owns the SQLite registry, assets, version history, full-text search and review fields. `index-http.mjs` adapts core calls to the browser. The browser opens indexed search results in the existing renderer.

Asset roots are user-selected, canonical directories. Discovery skips child symlinks and junctions. File paths stay relative to their root until opened. Generated caches and database files belong to the application data directory, resolved by `core/data-paths.mjs`.
