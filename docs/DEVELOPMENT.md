# Local development

```sh
npm ci
npm run check
npm test
npm start
```

Node.js 22.16 is the minimum version for the built-in SQLite backup API. CI tests current Node 22 and 24 releases on Windows and Linux. The lockfile pins all packages used for the viewer, Electron shell, CLI and MCP integration.

```sh
node scripts/generate-fixtures.mjs <output-directory> --include-errors
npm run benchmark
npm run cli -- --help
```

The fixture script writes original procedural samples. Its extended set includes malformed GLB, missing texture and identical-content files. The benchmark uses tiny generated OBJ files, times scan and hash reuse, and deletes the temporary fixture set.

Set `ASSET_VIEWER_TEST_NATIVE_UNREAL=1` and run `node --test test/unreal-native.test.mjs` on a machine with Unreal Editor. The test creates a temporary project and asks the editor to import a generated OBJ and PNG as native assets. It then checks their FBX and PNG exports, source hashes and index entries. Set `ASSET_VIEWER_TEST_UNREAL_VERSION` to select a discovered version.

Use `ASSET_VIEWER_DATA_DIR` and `ASSET_VIEWER_PORT` to isolate local tests. The HTTP test harness uses ephemeral ports. See [BUILD.md](BUILD.md) for the Electron smoke and packaging commands.
