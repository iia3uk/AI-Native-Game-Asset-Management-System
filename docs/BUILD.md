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

The Windows build validates that the package includes the Three.js loaders, decoder binaries and optional Blender script.

The default installer targets the current user. A desktop shortcut is created, and uninstall preserves application data. The installer and portable app share the same platform-specific data paths. There is no separate portable database beside the executable. Unsigned binaries may trigger Windows SmartScreen. For owner-controlled builds, Electron Builder accepts `CSC_LINK` and `CSC_KEY_PASSWORD`.

Pushing an intentional version tag matching `package.json` runs checks and prepares a draft GitHub Release. The owner reviews the artifact hashes and publishes the draft. Updating installed apps is manual.

## Isolated desktop smoke

On Windows, from PowerShell:

```powershell
$env:ASSET_VIEWER_DATA_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ('asset-viewer-smoke-' + [guid]::NewGuid())
npm run test:desktop
```

Set `ASSET_VIEWER_SMOKE_SCREENSHOT` to an absolute PNG path to capture the demo. The smoke test checks renderer isolation, the utility server, the local session token, the rendered demo, a background scan and watched updates with an unsaved metadata form open. It blocks external HTTP requests from the renderer during these checks. Set a distinct data directory when testing an unpacked, portable or installed binary.
