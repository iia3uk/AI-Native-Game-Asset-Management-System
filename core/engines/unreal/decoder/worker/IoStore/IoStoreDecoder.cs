using Blake3;
using AssetViewer.UnrealDecode.IoStore.Zen;
using AssetViewer.UnrealDecode.IoStore.Zen.Collision;
using AssetViewer.UnrealDecode.IoStore.Zen.Materials;
using AssetViewer.UnrealDecode.IoStore.Zen.Mesh;
using AssetViewer.UnrealDecode.Objects;
using AssetViewer.UnrealDecode.Objects.Audio;

namespace AssetViewer.UnrealDecode.IoStore;

internal sealed record IoStoreEntry(string Path, long Size, string Status, string? Issue, int? Output, string ChunkId,
    string? Kind = null, TextureExport? Texture = null, string? TextureIssue = null,
    AudioExport? Audio = null, string? AudioIssue = null,
    MeshExport? Mesh = null, string? MeshIssue = null, ZenIdentity? Identity = null,
    List<ZenMaterialSlot>? MeshMaterials = null, ZenMaterialExport? Material = null, string? MaterialIssue = null,
    ZenCollisionExport? Collision = null, string? CollisionIssue = null);
internal sealed record IoStoreReport(int Protocol, string Status, int ContainerVersion, int Chunks, int Partitions,
    IReadOnlyList<IoStoreEntry> Entries, int TextureDecoder, int AudioDecoder, int MeshDecoder, int MaterialDecoder, int CollisionDecoder);

internal static class IoStoreDecoder
{
    private const int MiB = 1024 * 1024;

    public static IoStoreReport Read(Request request)
    {
        var toc = new Toc();
        var resource = toc.Resource;
        var version = (int)resource.Header.Version;
        using var chunks = new Chunks(resource);
        var entries = new List<IoStoreEntry>(toc.Files.Length);
        var payloadIds = new HashSet<string>(StringComparer.Ordinal);
        var products = 0;
        long unpacked = 0;
        foreach (var file in toc.Files)
        {
            var identifier = toc.ChunkId(file.Chunk);
            if (!payloadIds.Add(identifier)) throw new InputException("unreal-iostore-duplicate-chunk");
            var range = resource.ChunkOffsetLengths[file.Chunk];
            var size = (long)range.Length;
            var kind = Kind(file.Path, resource.ChunkIds[file.Chunk].ChunkType, version);
            var issue = kind == null ? "unreal-iostore-unsupported-entry" :
                size <= 0 || size > 128 * MiB || (!request.InspectOnly && (products == 4000 || size > 1024 * MiB - unpacked))
                    ? "unreal-iostore-payload-limit" : !chunks.Supports(range) ? "unreal-iostore-compression" : null;
            if (issue == null && !request.InspectOnly && size > request.MaxOutputBytes - unpacked)
                issue = "unreal-iostore-space-limit";
            if (issue != null || request.InspectOnly)
            {
                entries.Add(new(file.Path, size, issue == null ? "available" : "skipped", issue, null, identifier, kind));
                continue;
            }

            var payload = chunks.Read(range);
            var actual = Hasher.Hash(payload);
            if (!actual.AsSpan()[..20].SequenceEqual(toc.ChunkHash(file.Chunk)))
                throw new InputException("unreal-iostore-chunk-hash");
            var outputPath = OutputPath(products, "bin");
            using (var output = File.Open(outputPath, FileMode.CreateNew, FileAccess.Write)) output.Write(payload);
            entries.Add(new(file.Path, size, "extracted", null, products++, identifier, kind));
            unpacked += size;
        }
        if (!request.InspectOnly && version >= 5) IoStoreAssets.Decode(entries, request.MaxOutputBytes - unpacked);
        return new(1, "completed", version, resource.ChunkIds.Length, (int)resource.Header.PartitionCount, entries,
            TexturePixels.Revision, 1, 1, 1, 1);
    }

    internal static string OutputPath(int index, string extension) => Path.Combine("output", index.ToString("D5") + "." + extension);

    private static string? Kind(string path, byte type, int version)
    {
        var legacy = version < 4;
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".uasset" or ".umap" when type == 1 || (legacy && type == 2) => "package",
            ".ubulk" when path.EndsWith(".m.ubulk", StringComparison.OrdinalIgnoreCase) =>
                type == 4 || (legacy && type == 5) ? "bulk" : null,
            ".ubulk" when type == 2 || (legacy && type == 3) => "bulk",
            ".uptnl" when type == 3 || (legacy && type == 4) => "bulk",
            ".png" or ".wav" or ".glb" or ".fbx" when type == 7 && !legacy => "file",
            ".bin" when type == 7 && !legacy &&
                Path.GetFileName(path).Equals("AssetRegistry.bin", StringComparison.OrdinalIgnoreCase) => "registry",
            _ => null,
        };
    }
}
