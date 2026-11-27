# Local security model

The HTTP listener binds to IPv4 loopback, accepts only its active port with `127.0.0.1` or `localhost`, validates supplied browser Origins and requires same-origin JSON for writes. Normal browser navigation can open the app from a link. The app uses CSP, type sniffing protection, resource isolation and a separate sandbox policy for asset SVG.

Library roots are explicit selections. Paths to child files are checked against the canonical root; symlinks and junctions under it are skipped. Fab metadata and Unity text reads are bounded. Source assets remain read-only. The legacy Fab selection document is an intentional metadata write through atomic replacement.

The technical analyzer only reads files discovered under the chosen root and applies byte limits to headers and source text. Metadata lookup joins dependency paths against the same library's index. Absolute paths, traversal outside the library and external URIs are recorded by status. Remote URLs, absolute references and data URI payloads are omitted from the report.

The background thumbnail renderer receives only a verified indexed source and its in-library geometry buffers. It strips texture fetches and other URI-bearing fields before passing glTF geometry to the loader. Byte, geometry and render limits apply in a terminable worker. The HTTP image route derives the cache entry from the asset ID and current source version. The MCP tool checks library scope and returns cached PNG data without exposing local cache paths.

Unity package import reads explicitly selected local files and checks for TAR.GZ with Unity GUID records. It rejects archive links, special records, bad checksums, traversal, device names and path collisions. Staging filenames use validated GUIDs and fixed record names. The importer uses a payload allowlist and excludes scripts, plugins and executables from the published tree. It does not run an editor or evaluate Unity YAML. Compressed size is limited to 1 GiB, decompressed size to 4 GiB, a member to 512 MiB and a TAR to 30,000 records. Smaller limits apply to metadata and previews. The import checks free space and uses a 10-minute worker timeout. Stages are removed on completion or cancellation. A subsequent import cleans up abandoned stages older than one hour.

The desktop user and other processes on the same account are inside the trust boundary. Portable path checks reduce link substitution risk; fully concurrent filesystem changes require stronger native isolation. Browser loaders and Blender native importers are still exposed to malformed inputs. Blender uses an argument vector, factory startup and disabled script auto-execution, with limits on concurrency, input size, timeout and captured output. Its internal dependency resolution runs with the user's OS permissions.

For protocol, format and packaging work, see the open verification items in [AUDIT.md](AUDIT.md).
