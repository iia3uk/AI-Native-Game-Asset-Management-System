# Development status

The baseline is `aff0312` on `origin/main`. Development is local on `develop/asset-core`.

- Existing capabilities include Fab browsing and review, local folders, manual texture overrides, direct model and texture previews and optional Blender conversion.
- Initial hardening added shared file and metadata guards, origin checks, HTTP regression tests and a bounded Blender queue.
- The opt-in demo has four procedurally generated models, including an animated cabin and a textured OBJ. The fixture generator includes an optional error and duplicate set.
- The SQLite library connects or disconnects chosen roots, performs incremental scans, detects hash duplicates and records missing files and move history. Indexed metadata supports tags, category, review, notes and license. Search supports text, library and file type filters. Results open in the existing viewer.
- Verified with Node.js 24.18.0 on Windows. The baseline passed 22 tests and started successfully. The current suite covers HTTP boundaries, Fab compatibility, the demo, index persistence, backup and schema checks.
- Browser smoke covered opening the demonstration, playing and pausing its animation, connecting 10 generated fixtures, searching, saving metadata, reopening the model and finding its saved metadata after a page reload.
- Blender was unavailable in PATH and common install locations. A real Blender conversion, cross-platform behavior and desktop packaging still require verification.
- Next priorities are the CLI, Windows packaging, and a durable background queue. See [ROADMAP.md](ROADMAP.md).
