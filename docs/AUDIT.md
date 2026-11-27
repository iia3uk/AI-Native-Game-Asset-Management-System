# Initial audit

Baseline `aff0312` contains eight commits. All 22 initial tests passed under Node.js 24.18.0. The loopback app responded with HTTP 200 without a Fab library. The renderer is a native browser module app with separate helpers for formats, animation, materials, thumbnail generation and browser settings. Three.js loaders are patched by a reproducible postinstall script.

| Area | Finding | Work |
| --- | --- | --- |
| HTTP | The listener was loopback-only and writes verified browser Origin. Reads lacked consistent cross-origin rejection. | Central same-origin and Host checks. Tests cover accepted local requests, rejected origins and unrecognized Host. |
| Filesystem | HTTP asset reads resolved real paths. Fab catalog/review operations and Unity metadata reads bypassed that check. Child aliases could hide replacement of an approved subtree. | Shared canonical child path verification, bounded metadata reads, separate checks at file access, random exclusive review staging, link/junction regression coverage. |
| Blender | Argument vector, disabled auto-execution and time/output limits were present. Distinct conversions ran without a shared cap and temporary files accumulated. | One active conversion, at most eight pending requests, a 512 MiB source limit, partial cleanup and graceful-shutdown cleanup. Blender was unavailable on the Windows host. |
| Preview | Model swaps dispose geometry, materials, textures, skeletons and bitmaps. Loaders clean up temporary object URLs and decoder workers. Thumbnails already have a serialized render path and bounded entry cache. | Browser lifetime, cancellation, decompression and GPU memory budgets warrant dedicated stress tests. |
| Libraries | The browser stores connected folders, categories, marks and texture overrides per origin. Server scan state is in-memory. Fab stores its existing `Viewer/selections.json`. | Introduce a durable local registry, keep the legacy store readable, and provide explicit import before changing the metadata source of truth. |
| Scan and search | Local scans walk every relevant directory and re-resolve materials. Group filtering is in-memory. Collection-wide resource lists may grow large. | Reuse format discovery in SQLite; skip hashing unchanged files; paginate indexed search. Benchmark independently from rendering. |
| Asset inputs | Runtime parses complex binary and text formats in the browser and converts selected files with an external Blender process. | Treat dependencies and documents as untrusted; stronger process isolation and renderer-level resource budgets remain open. |
| Deployment | The package initially offered start and test scripts. Windows/Linux/macOS behavior outside the current host was unverified. | Add separate CI verification and reproducible desktop packaging once core boundaries are stable. |

Further validation includes large and malformed model files, advanced loaders and texture dependencies, live Fab catalogs, Blender imports and long-running viewer sessions.
