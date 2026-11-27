# Architecture decisions

## Preserve the existing viewer

Retain the Three.js preview, Fab review store and browser compatibility while introducing an independent core in small releases. Extract shared file access first so discovery, previews and metadata parsing use consistent path rules.

## Local trust boundary

Use a loopback listener, exact accepted Host names and same-origin JSON for changes. Reject child path aliases across selected roots and check paths again at access. Blender runs as the current user with auto-execution disabled and a bounded queue. Running native importers with OS-enforced isolation is separate work.

## Persistent index and identity

Use Node's built-in SQLite, WAL and a schema version. Each registered path gets its own asset ID. SHA-256 groups duplicate content. A unique hash in both snapshots can retain identity when an available asset disappears and appears at a new unclaimed path in the same scan. Copy ambiguity preserves the old entry and creates a new ID. A missing asset keeps its metadata and history.

A scan collects a snapshot asynchronously and then commits it in one transaction. A per-library generation prevents a scan from replacing a newer snapshot or undoing disconnection. Files above 1 GiB are indexed without a hash. Other files reuse the cached hash on matching size, modification time and change time.

SQLite owns metadata created in the indexed-library workflow. The Fab selection document and the browser's original local catalog continue using their existing stores. Importing old data into the index requires a separate, explicit operation.
