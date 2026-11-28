using System.Buffers.Binary;
using AssetViewer.UnrealDecode.Formats;
using AssetViewer.UnrealDecode.IoStore.Zen.Audio;
using AssetViewer.UnrealDecode.IoStore.Zen.Materials;
using AssetViewer.UnrealDecode.IoStore.Zen.Mesh;

namespace AssetViewer.UnrealDecode.IoStore.Zen;

internal static class IoStoreAssets
{
    private const long MiB = 1024 * 1024;

    public static void Decode(List<IoStoreEntry> entries, long remaining)
    {
        remaining = Math.Min(remaining, 256 * MiB);
        var materialBudget = 4096;
        var slotBudget = 4096;
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
                entry = entry with { Identity = package.Identity };
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
                    var (mesh, slots) = ZenStaticMesh.Read(bytes, package, companions, output.ToString("D5"), remaining);
                    entries[i] = slots.Count <= slotBudget ? entry with { Mesh = mesh, MeshMaterials = slots } :
                        entry with { Mesh = mesh with { Limited = true } };
                    slotBudget -= Math.Min(slots.Count, slotBudget);
                    remaining -= mesh.Lods.Sum(lod => lod.Size);
                }
                else if (kind is ZenExportKind.Material or ZenExportKind.MaterialInstance)
                {
                    if (materialBudget == 0) throw new InputException("limit");
                    var material = ZenMaterial.Read(bytes, package, kind);
                    var cost = 1 + material.Textures.Length + material.Scalars.Length +
                        material.Vectors.Length + material.Streaming.Length;
                    if (cost > materialBudget) throw new InputException("limit");
                    materialBudget -= cost;
                    entries[i] = entry with { Material = material };
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
        ZenExportKind.Material or ZenExportKind.MaterialInstance => entry with { MaterialIssue = "unreal-iostore-material-" + code },
        _ => entry,
    };
}
