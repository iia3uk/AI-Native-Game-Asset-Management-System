using System.Buffers.Binary;
using AssetViewer.UnrealDecode.Formats;

namespace AssetViewer.UnrealDecode.IoStore.Zen;

internal static class IoStoreTextures
{
    private const long MiB = 1024 * 1024;

    public static void Decode(List<IoStoreEntry> entries, long remaining)
    {
        remaining = Math.Min(remaining, 256 * MiB);
        var sidecars = new Dictionary<(string Chunk, string Path), string>();
        foreach (var entry in entries)
        {
            if (entry.Kind == "bulk" && entry.Output is int output)
                sidecars.Add((entry.ChunkId[..22], entry.Path.Normalize().ToUpperInvariant()), IoStoreDecoder.OutputPath(output, "bin"));
        }

        for (var i = 0; i < entries.Count; i++)
        {
            var entry = entries[i];
            if (entry.Kind != "package" || entry.Output is not int output || entry.Size > 64 * MiB ||
                !entry.Path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase) || entry.ChunkId[16..22] != "000000") continue;
            var stem = entry.Path[..^7].Normalize().ToUpperInvariant();
            var companions = new Dictionary<string, string>();
            foreach (var extension in new[] { ".ubulk", ".uptnl", ".m.ubulk" })
                if (sidecars.TryGetValue((entry.ChunkId[..22], stem + extension.ToUpperInvariant()), out var path))
                    companions.Add(extension, path);
            var packageId = BinaryPrimitives.ReadUInt64LittleEndian(Convert.FromHexString(entry.ChunkId[..16]));
            try
            {
                var texture = ZenTexture.Read(IoStoreDecoder.OutputPath(output, "bin"), packageId, companions, remaining);
                if (texture == null) continue;
                var (pixels, metadata) = texture.Value;
                if (Png.MaximumSize(pixels.Length, metadata.Height) > remaining)
                    throw new InputException("unreal-iostore-texture-limit");
                using var image = File.Open(IoStoreDecoder.OutputPath(output, "png"), FileMode.CreateNew, FileAccess.Write);
                Png.Write(image, metadata.Width, metadata.Height, pixels, metadata.Srgb);
                entries[i] = entry with { Texture = metadata with { Size = image.Length } };
                remaining -= image.Length;
            }
            catch (InputException error)
            {
                entries[i] = entry with { TextureIssue = error.Code };
            }
            catch (IOException)
            {
                entries[i] = entry with { TextureIssue = "unreal-iostore-texture-io" };
            }
        }
    }
}
