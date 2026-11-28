using AssetViewer.UnrealDecode.Objects;
using AssetViewer.UnrealDecode.Objects.Audio;

namespace AssetViewer.UnrealDecode.Pak;

internal static class PakAudio
{
    public static void Decode(List<Entry> entries, long remaining)
    {
        remaining = Math.Min(remaining, CookedSoundWave.BatchLimit);
        var sources = entries.Where(entry => entry.Output.HasValue)
            .ToDictionary(entry => entry.Path.Normalize(), StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < entries.Count; i++)
        {
            var entry = entries[i];
            if (entry.Output is not int index || entry.Texture != null || entry.TextureIssue != null ||
                !entry.Path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)) continue;
            var stem = entry.Path[..^7].Normalize();
            if (sources.ContainsKey(stem + ".umap")) continue;
            CookedInput? Sidecar(string extension) => Input(sources.GetValueOrDefault(stem + extension));
            try
            {
                var product = CookedSoundWave.Decode(Input(entry), Sidecar(".uexp"), Sidecar(".ubulk"), Sidecar(".uptnl"),
                    Path.Combine("output", index.ToString("D5")), remaining);
                if (product == null) continue;
                entries[i] = entry with { Audio = product };
                remaining -= product.Size;
            }
            catch (InputException error) { entries[i] = entry with { AudioIssue = CookedSoundWave.Issue(error.Code) }; }
            catch (EndOfStreamException) { entries[i] = entry with { AudioIssue = CookedSoundWave.Issue("layout") }; }
            catch (IOException) { entries[i] = entry with { AudioIssue = CookedSoundWave.Issue("io") }; }
        }
    }

    private static CookedInput? Input(Entry? entry) => entry?.Output is int index
        ? new CookedInput(PakDecoder.OutputPath(index, "bin"), entry.Size) : null;
}
