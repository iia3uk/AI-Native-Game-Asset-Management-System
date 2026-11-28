using System.Buffers.Binary;
using AssetViewer.UnrealDecode.Formats;
using AssetViewer.UnrealDecode.IoStore.Zen.Audio;
using AssetViewer.UnrealDecode.IoStore.Zen.Mesh;

namespace AssetViewer.UnrealDecode.IoStore.Zen;

internal static class IoStoreAssets
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
            var kind = ZenExportKind.None;
            try
            {
                var chunk = File.ReadAllBytes(IoStoreDecoder.OutputPath(output, "bin"));
                var package = ZenPackage.Read(chunk, packageId, out kind);
                if (package == null) continue;
                var bytes = chunk.AsSpan(package.Offset, package.Size).ToArray();
                if (kind == ZenExportKind.SoundWave)
                {
                    var (audio, format) = ZenSoundWave.Read(bytes, package, companions, remaining);
                    using var target = File.Open(IoStoreDecoder.OutputPath(output, format), FileMode.CreateNew, FileAccess.Write);
                    target.Write(audio);
                    entries[i] = entry with { Audio = new(format, audio.Length) };
                    remaining -= audio.Length;
                }
                else if (kind == ZenExportKind.StaticMesh)
                {
                    var mesh = ZenStaticMesh.Read(bytes, package, companions, output.ToString("D5"), remaining);
                    entries[i] = entry with { Mesh = mesh };
                    remaining -= mesh.Lods.Sum(lod => lod.Size);
                }
                else
                {
                    var (pixels, metadata) = ZenTexture.Read(bytes, package, companions, remaining);
                    if (Png.MaximumSize(pixels.Length, metadata.Height) > remaining) throw new InputException("limit");
                    using var image = File.Open(IoStoreDecoder.OutputPath(output, "png"), FileMode.CreateNew, FileAccess.Write);
                    Png.Write(image, metadata.Width, metadata.Height, pixels, metadata.Srgb);
                    entries[i] = entry with { Texture = metadata with { Size = image.Length } };
                    remaining -= image.Length;
                }
            }
            catch (InputException error)
            {
                entries[i] = ReportIssue(entry, kind, error.Code);
            }
            catch (EndOfStreamException)
            {
                entries[i] = ReportIssue(entry, kind, "layout");
            }
            catch (IOException)
            {
                entries[i] = ReportIssue(entry, kind, "io");
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                entries[i] = ReportIssue(entry, kind, "layout");
            }
        }
    }

    private static IoStoreEntry ReportIssue(IoStoreEntry entry, ZenExportKind kind, string code) => kind switch
    {
        ZenExportKind.Texture => entry with { TextureIssue = "unreal-iostore-texture-" + code },
        ZenExportKind.SoundWave => entry with { AudioIssue = "unreal-iostore-audio-" + code },
        ZenExportKind.StaticMesh => entry with { MeshIssue = "unreal-iostore-mesh-" + code.Replace("unreal-cooked-mesh-", "") },
        _ => entry,
    };
}
