using CUE4Parse.UE4.Pak;
using CUE4Parse.UE4.Pak.Objects;
using CUE4Parse.UE4.Versions;

namespace AssetViewer.UnrealDecode.Pak;

internal static class PakDecoder
{
    private const long MiB = 1024 * 1024;
    private static readonly HashSet<string> ExportTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "uasset", "umap", "uexp", "ubulk", "uptnl", "png", "wav", "fbx", "glb"
    };

    public static Report Read(Request request)
    {
        var path = Path.GetFullPath("input.pak");
        using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length is < 44 or > 2048 * MiB) throw new InputException("unreal-pak-size-limit");
        using var reader = new PakFileReader(path, stream, new VersionContainer(EGame.GAME_UE5_LATEST));
        var info = reader.Info;
        if (info.Magic != FPakInfo.PAK_FILE_MAGIC || info.IndexIsFrozen ||
            (int)info.Version is < 1 or > 12) throw new InputException("unreal-pak-layout");
        if (reader.IsEncrypted) throw new InputException("unreal-pak-encrypted");
        var files = PakIndex.Read(reader, stream);
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var entries = new List<Entry>();
        long unpacked = 0;
        int products = 0;
        foreach (var file in files.OrderBy(file => file.Path, StringComparer.Ordinal))
        {
            var name = PakPaths.Check(file.Path);
            if (!paths.Add(name.Normalize())) throw new InputException("unreal-pak-path-collision");

            var issue = Exclusion(file, info, unpacked, products, request);
            if (issue != null || request.InspectOnly)
            {
                entries.Add(new Entry(name, file.UncompressedSize, issue == null ? "available" : "skipped", issue, null));
                continue;
            }

            var payload = PakPayload.Read(reader, stream, file);
            if (payload.LongLength != file.UncompressedSize)
                throw new InputException("unreal-pak-payload-size");
            var destination = Path.Combine("output", products.ToString("D5") + ".bin");
            using (var output = File.Open(destination, FileMode.CreateNew, FileAccess.Write)) output.Write(payload);
            entries.Add(new Entry(name, payload.LongLength, "extracted", null, products));
            unpacked += payload.LongLength;
            products++;
        }
        return new Report(1, "completed", (int)info.Version, entries);
    }

    private static string? Exclusion(FPakEntry file, FPakInfo info, long unpacked, int products, Request request)
    {
        if (file.IsEncrypted) return "unreal-pak-encrypted-entry";
        if (file.IsDeleted || !ExportTypes.Contains(file.Extension)) return "unreal-pak-unsupported-entry";
        if (!PakPayload.Supports(file)) return "unreal-pak-unsupported-compression";
        if (file.UncompressedSize is <= 0 or > 128 * MiB || file.CompressedSize is <= 0 or > 128 * MiB ||
            products >= 4000 || file.UncompressedSize > 1024 * MiB - unpacked) return "unreal-pak-payload-limit";
        if (!request.InspectOnly && file.UncompressedSize > request.MaxOutputBytes - unpacked) return "unreal-pak-space-limit";
        PakPayload.CheckBounds(file, info);
        return null;
    }
}
