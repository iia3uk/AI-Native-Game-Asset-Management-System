# Architecture

`server.mjs` is the loopback HTTP adapter. The browser renderer lives in `public/`, with the 3D stage separated from catalog UI and thumbnail scheduling. Legacy local grouping and Unity material resolution are currently in `scripts/`. Fab remains a separate file-backed source.

`core/` owns browser-independent access and discovery. The same format registry drives discovery and existing preview support. Future interfaces should call the core directly for storage and search.

Asset roots are user-selected, canonical directories. Discovery skips child symlinks and junctions. File paths stay relative to their root until opened. Generated caches and database files belong to the application data directory.
