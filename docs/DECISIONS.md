# Architecture decisions

## Preserve the existing viewer

Retain the Three.js preview, Fab review store and browser compatibility while introducing an independent core in small releases. Extract shared file access first so discovery, previews and metadata parsing use consistent path rules.

## Local trust boundary

Use a loopback listener, exact accepted Host names and same-origin JSON for changes. Reject child path aliases across selected roots and check paths again at access. Blender runs as the current user with auto-execution disabled and a bounded queue. Running native importers with OS-enforced isolation is separate work.
