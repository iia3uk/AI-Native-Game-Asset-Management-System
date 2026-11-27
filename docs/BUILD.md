# Build Asset Viewer

Use Node.js 22.16 or later for source development. The Windows x64 desktop app includes its own Node.js and Electron. Blender is optional and uses the installed executable or an absolute `ASSET_VIEWER_BLENDER` setting.

```sh
npm ci
npm run check
npm test
npm run desktop
npm run build:windows
```

`build:windows` writes the NSIS installer, portable executable and `SHA256SUMS.txt` to `release/`. It runs with publishing disabled. Running the desktop app from the source tree may download the pinned Electron runtime on first launch. Packaging may download additional Windows build tools.

The Windows build validates that the package includes the thumbnail worker, Three.js loaders, decoder binaries and optional Blender script.

The default installer targets the current user. A desktop shortcut is created, and uninstall preserves application data. The installer and portable app share the same platform-specific data paths. There is no separate portable database beside the executable. Unsigned binaries may trigger Windows SmartScreen. For owner-controlled builds, Electron Builder accepts `CSC_LINK` and `CSC_KEY_PASSWORD`.

Pushing an intentional version tag matching `package.json` runs checks and prepares a draft GitHub Release. The owner reviews the artifact hashes and publishes the draft. Updating installed apps is manual.

## Build the optional Unreal Pak worker

Install the .NET 10 SDK on the build machine and run `npm run build:cue4parse`. The script restores locked dependencies and writes a self-contained executable and its runtime to `release/cue4parse/win-x64/` or `release/cue4parse/linux-x64/`. Run `npm run build:cue4parse -- linux-x64` or specify `win-x64` to select a target explicitly.

Keep the published files together. Runtime use does not require a .NET SDK or Unreal Editor. Linux still needs the platform libraries required by .NET, including ICU. The source CLI discovers the published worker automatically. For a different location, set `ASSET_VIEWER_CUE4PARSE` to the absolute path of the worker executable. The default Electron installer does not include this optional worker.

## Isolated desktop smoke

On Windows, from PowerShell:

```powershell
$env:ASSET_VIEWER_DATA_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ('asset-viewer-smoke-' + [guid]::NewGuid())
npm run test:desktop
```

Set `ASSET_VIEWER_SMOKE_SCREENSHOT` to an absolute PNG path to capture the demo. The smoke test checks renderer isolation, the utility server, the local session token, thumbnail generation and cache clearing, a background scan and watched updates with an unsaved metadata form open. It blocks external HTTP requests from the renderer during these checks. Set a distinct data directory when testing an unpacked, portable or installed binary.
