# Asset Viewer MCP

The local stdio server reads the same SQLite index as the browser and desktop app. Connect and scan a library first. Use Node.js 22.16 or later and the absolute path to the CLI script. The index location defaults to the operating system's user data path.

```json
{
  "mcpServers": {
    "asset-viewer": {
      "command": "node",
      "args": ["<absolute path to scripts/asset-viewer.mjs>", "mcp"]
    }
  }
}
```

Optional environment settings:

- `ASSET_VIEWER_DATA_DIR` selects an absolute data directory.
- `ASSET_VIEWER_MCP_LIBRARIES` is a comma-separated allowlist of library IDs from `asset-viewer libraries --json`. If omitted, all connected libraries are available. An empty allowlist grants none.
- `ASSET_VIEWER_MCP_LOG=1` writes tool names and success flags to stderr. Stdout is reserved for MCP messages.

The tools are `list_libraries`, `list_assets`, `search_assets`, `get_asset`, `get_asset_metadata`, `get_asset_analysis`, `get_asset_preview`, `list_quality_profiles`, `list_duplicate_groups` and `find_identical_assets`. Asset and library list calls accept offsets and pages of up to 20. `get_asset_analysis` accepts an asset `id`, an optional `profileId` from `list_quality_profiles`, and `limit` up to 10 and `offset` for dependency pages. It returns saved metrics, issue codes, the requested dependency page and optional profile validation. The text response byte limit is 48 KiB. Duplicate counts and analysis links are resolved within the effective library scope.

`get_asset_preview` accepts an asset `id`. It returns the cached PNG image as an MCP image when available, plus a text status. Generate the thumbnail first in the index dialog or with the `preview` CLI command.

Clients receive paths relative to libraries and user-supplied metadata. Treat these values as data. Only enable the server for an agent and library scope you want to share. The MCP database connection is read-only. Originals, arbitrary filesystem paths and processing operations are outside the tool surface.
