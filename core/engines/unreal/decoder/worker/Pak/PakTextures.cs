using AssetViewer.UnrealDecode.Formats;
using AssetViewer.UnrealDecode.Objects;

namespace AssetViewer.UnrealDecode.Pak;

internal static class PakTextures
{
    private const long MaxDecodedBytes = 256L * 1024 * 1024;

    public static long Decode(List<Entry> entries, long space)
    {
        var sources = entries.Where(entry => entry.Output.HasValue)
            .ToDictionary(entry => entry.Path.Normalize(), StringComparer.OrdinalIgnoreCase);
        var budget = Math.Min(space, MaxDecodedBytes);
        var remaining = budget;
        for (var i = 0; i < entries.Count; i++)
        {
            var entry = entries[i];
            if (entry.Output is not int index || !entry.Path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)) continue;
            var stem = entry.Path[..^7].Normalize();
            Entry? Sidecar(string extension) => sources.GetValueOrDefault(stem + extension);
            try
            {
                if (Sidecar(".umap") != null) continue;
                var texture = CookedTexture.Read(Input(entry), Input(Sidecar(".uexp")), Input(Sidecar(".ubulk")),
                    Input(Sidecar(".uptnl")), remaining);
                if (texture == null) continue;
                var (data, export) = texture.Value;
                var maximumSize = Png.MaximumSize(data.Length, export.Height);
                if (maximumSize > remaining) throw new InputException("unreal-cooked-texture-limit");
                using var output = File.Open(PakDecoder.OutputPath(index, "png"), FileMode.CreateNew, FileAccess.Write);
                Png.Write(output, export.Width, export.Height, data);
                entries[i] = entry with { Texture = export with { Size = output.Length } };
                remaining -= output.Length;
            }
            catch (InputException error)
            {
                entries[i] = entry with { TextureIssue = error.Code };
            }
            catch (IOException)
            {
                entries[i] = entry with { TextureIssue = "unreal-cooked-texture-io" };
            }
        }
        return budget - remaining;
    }

    private static CookedInput? Input(Entry? entry) => entry?.Output is int index
        ? new CookedInput(PakDecoder.OutputPath(index, "bin"), entry.Size) : null;
}
