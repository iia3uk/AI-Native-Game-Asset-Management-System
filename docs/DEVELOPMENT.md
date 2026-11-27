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

After building the independent worker, set `ASSET_VIEWER_TEST_CUE4PARSE=1` and run `node --test test/unreal-pak-decoder.test.mjs`. The test writes stock Pak v4 and v11 archives containing generated model and audio files, checks byte equality and shared index results, and exercises corrupt archives, path collisions, forbidden entry types and encrypted entries. The default tests also check the launcher's worker protocol and reject encrypted indexes without using the worker.

After building the Unity AssetBundle worker, set `ASSET_VIEWER_TEST_NATIVE_BUNDLE=1` and run `node --test test/unity-bundle.test.mjs`. Unity 6000.3.10f1 creates the native fixture from generated texture and mesh data. The CLI uses AssetsTools.NET for import. The test checks serialized IDs, PNG pixels and orientation, indexing, unsupported classes and truncated input. `ASSET_VIEWER_TEST_UNITY_VERSION` can select a different installed Editor.

UnityPy and AssetRipper were evaluated as independent Unity binary decoders. The published UnityPy package is MIT-licensed and includes a Python runtime dependency stack. AssetRipper is GPL-3.0. This worker pins the MIT-licensed [AssetsTools.NET](https://www.nuget.org/packages/AssetsTools.NET/3.0.5), which reads UnityFS and embedded type trees from the same self-contained .NET setup used for Unreal. The app does not include code from either alternate extractor. See [UnityPy](https://pypi.org/project/UnityPy/) and [AssetRipper](https://github.com/AssetRipper/AssetRipper) for their capabilities and terms.

Use `ASSET_VIEWER_DATA_DIR` and `ASSET_VIEWER_PORT` to isolate local tests. The HTTP test harness uses ephemeral ports. See [BUILD.md](BUILD.md) for the Electron smoke and packaging commands.
