# Asset Viewer development

- Read `docs/STATUS.md` and the relevant architecture and security docs before changing a subsystem.
- Use `npm ci` and `npm test`. Add synthetic regression fixtures for changes to indexing, user data, or file-access boundaries.
- Preserve the original 3D viewer, Fab layout, selections and existing browser settings across compatible changes.
- Keep file discovery, indexing and processing independent of the browser and desktop shell. Use the same core from each interface.
- Organize core code by responsibility. Keep archive handling, engine-specific adapters, conversion, index and UI components in their own directories as they are added.
- Treat the selected library root as a read-only asset boundary. Use application directories for generated data.
- Keep runtime databases, secrets, machine-local configuration and private assets out of Git.
- Update status and docs with each tested milestone. Commit locally. Publishing, creating release tags and external transfers require specific authorization.
