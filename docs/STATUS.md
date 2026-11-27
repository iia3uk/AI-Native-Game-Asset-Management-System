# Development status

The baseline is `aff0312` on `origin/main`. Development is local on `develop/asset-core`.

- Existing capabilities include Fab browsing and review, local folders, manual texture overrides, direct model and texture previews and optional Blender conversion.
- Initial hardening added shared file and metadata guards, origin checks, HTTP regression tests and a bounded Blender queue.
- Verified with Node.js 24.18.0 on Windows. The baseline passed 22 tests and started successfully. The hardening suite adds 2 HTTP tests.
- Blender was unavailable in PATH and common install locations. A real Blender conversion, cross-platform behavior and desktop packaging still require verification.
- Next milestone is a procedural demo and an end-to-end persistent library with search. See [ROADMAP.md](ROADMAP.md).
