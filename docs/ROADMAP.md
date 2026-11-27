# Roadmap

The sections describe planned increments. See [STATUS.md](STATUS.md) for shipped work.

- **Viewer:** hardening, visual regression checks, procedural sample library and Windows installer.
- **Manager:** SQLite libraries, incremental scans, search, backups, metadata, collections and duplicates.
- **Automation:** directory watching, durable jobs, previews and managed caches, quality profiles and declarative rules.
- **Intelligence:** deterministic classification, optional providers, reviewable suggestions and hybrid search.
- **Agent integration:** CLI and read-only MCP over stdio, with controlled writes introduced separately.
- **Pipeline:** staged export plans, dependency manifests, project profiles and engine adapters.
- **Release readiness:** packaging, CI, documentation, offline smoke tests, cross-platform validation and an owner-approved release policy.

## Package extraction and conversion

1. Extract Unity package originals with dependency reports and a searchable library.
2. Discover installed Unity and Unreal versions and configured Blender.
3. Export model and texture batches with provenance and separate viewer derivatives.
4. Add a Unity Editor bridge with trusted code and allowlisted project inputs.
5. Add an Unreal Editor bridge and an independent cooked-asset worker.
6. Add independent Unity bundle decoding, material reconstruction and automated imports in opted-in folders.
