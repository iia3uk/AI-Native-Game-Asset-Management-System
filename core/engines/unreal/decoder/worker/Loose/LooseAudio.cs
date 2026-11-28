using System.Globalization;
using AssetViewer.UnrealDecode.Objects;
using AssetViewer.UnrealDecode.Objects.Audio;

namespace AssetViewer.UnrealDecode.Loose;

internal static class LooseAudio
{
    public static object Read(Request request)
    {
        if (request.InspectOnly || request.Count is < 1 or > 512) throw new InputException("unreal-worker-request");
        var remaining = Math.Min(request.MaxOutputBytes, CookedSoundWave.BatchLimit);
        var entries = new List<Row>(request.Count);
        for (var index = 0; index < request.Count; index++)
        {
            var stem = index.ToString("D5", CultureInfo.InvariantCulture);
            try
            {
                var header = Input(stem + ".uasset") ?? throw new IOException();
                var product = CookedSoundWave.Decode(header, Input(stem + ".uexp"), Input(stem + ".ubulk"), Input(stem + ".uptnl"),
                    Path.Combine("output", stem), remaining);
                entries.Add(new(index, product));
                remaining -= product?.Size ?? 0;
            }
            catch (InputException error) { entries.Add(new(index, AudioIssue: CookedSoundWave.Issue(error.Code))); }
            catch (EndOfStreamException) { entries.Add(new(index, AudioIssue: CookedSoundWave.Issue("layout"))); }
            catch (IOException) { entries.Add(new(index, AudioIssue: CookedSoundWave.Issue("io"))); }
        }
        return new { protocol = 1, status = "completed", audioDecoder = 1, entries };
    }

    private static CookedInput? Input(string name)
    {
        var file = new FileInfo(name);
        return file.Exists ? new(name, file.Length) : null;
    }

    private sealed record Row(int Index, AudioExport? Audio = null, string? AudioIssue = null);
}
