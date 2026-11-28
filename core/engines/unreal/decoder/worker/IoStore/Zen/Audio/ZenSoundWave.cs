using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;

namespace AssetViewer.UnrealDecode.IoStore.Zen.Audio;

internal sealed record AudioExport(string Format, long Size);

internal static class ZenSoundWave
{
    public static (byte[] Bytes, string Format) Read(byte[] bytes, ZenPackage package,
        IReadOnlyDictionary<string, string> sidecars, long remaining)
    {
        using var source = new FByteArchive("SoundWave", bytes, package.Version);
        using var archive = new FAssetArchive(source, package);
        bool? streaming = null;
        bool? loading = null;
        ZenProperties.Read(archive, tag =>
        {
            switch (tag.Name.Text)
            {
                case "bStreaming":
                    if (streaming != null) throw ZenPackage.Invalid();
                    streaming = ZenProperties.TaggedBoolean(tag);
                    break;
                case "LoadingBehavior":
                    if (loading != null || tag.ArrayIndex != 0 || tag.Size != 8 ||
                        tag.PropertyType.Text is not ("ByteProperty" or "EnumProperty") ||
                        tag.SerializeType != EPropertyTagSerializeType.Property) throw ZenPackage.Invalid();
                    var name = archive.ReadFName();
                    loading = !name.IsNone && name.Text != "ESoundWaveLoadingBehavior::ForceInline" &&
                        name.Text != "ForceInline";
                    break;
            }
        });
        if (ZenProperties.Boolean(archive)) archive.Position += 16; // UObject GUID
        var flags = archive.Read<uint>();
        if ((flags & 1) == 0 || (flags & ~31u) != 0) throw new InputException("platform");
        if (archive.Game >= EGame.GAME_UE5_4 && archive.Read<int>() != 0)
            throw new InputException("cue-points");

        remaining = Math.Min(remaining, 32 * 1024 * 1024);
        var result = (streaming ?? loading ?? true)
            ? ReadStream(archive, package, bytes, sidecars, remaining)
            : ReadInline(archive, package, bytes, sidecars, remaining);
        if (archive.Position != archive.Length) throw ZenPackage.Invalid();
        return result;
    }

    private static (byte[], string) ReadInline(FAssetArchive archive, ZenPackage package, byte[] bytes,
        IReadOnlyDictionary<string, string> sidecars, long remaining)
    {
        var count = archive.Read<int>();
        if (count is < 1 or > 8) throw ZenPackage.Invalid();
        string? format = null;
        ZenBulkData? selected = null;
        for (var i = 0; i < count; i++)
        {
            var candidate = AudioFormat(archive.ReadFName().Text);
            var payload = ZenBulkData.Read(archive, package.Bulk, archive.Length - 16);
            if (candidate == null || selected != null || payload.Size == 0) continue;
            (format, selected) = (candidate, payload);
        }
        archive.Position += 16; // CompressedDataGuid
        if (selected == null || format == null) throw new InputException("format");
        if (selected.Size > remaining) throw new InputException("limit");
        return (ReadChunk(selected, bytes, sidecars, (int)selected.Size), format);
    }

    private static (byte[], string) ReadStream(FAssetArchive archive, ZenPackage package, byte[] bytes,
        IReadOnlyDictionary<string, string> sidecars, long remaining)
    {
        archive.Position += 16; // CompressedDataGuid
        var count = archive.Read<int>();
        if (count is < 1 or > 512) throw ZenPackage.Invalid();
        var format = AudioFormat(archive.ReadFName().Text) ?? throw new InputException("format");
        var chunks = new (ZenBulkData Payload, int Length)[count];
        long total = 0;
        for (var i = 0; i < count; i++)
        {
            var flags = archive.Read<uint>();
            if ((flags & 1) == 0 || (flags & ~7u) != 0) throw ZenPackage.Invalid();
            var payload = ZenBulkData.Read(archive, package.Bulk, archive.Length - 8);
            var stored = archive.Read<int>();
            var length = archive.Read<int>();
            if ((flags & 2) != 0) _ = archive.Read<uint>();
            if (length <= 0 || stored < length || stored > payload.Size) throw ZenPackage.Invalid();
            total += length;
            if (total > remaining) throw new InputException("limit");
            chunks[i] = (payload, length);
        }
        if (archive.Position != archive.Length) throw ZenPackage.Invalid();
        var result = new byte[(int)total];
        var offset = 0;
        foreach (var (payload, length) in chunks)
        {
            ReadChunk(payload, bytes, sidecars, length).CopyTo(result, offset);
            offset += length;
        }
        return (result, format);
    }

    private static byte[] ReadChunk(ZenBulkData payload, byte[] export, IReadOnlyDictionary<string, string> sidecars,
        int length) => payload.ReadBytes(export, sidecars, length) ?? throw new InputException("bulk-unavailable");

    private static string? AudioFormat(string name) => name.Split('_', 2)[0].ToUpperInvariant() switch
    {
        "OGG" => "ogg",
        "PCM" => "wav",
        _ => null,
    };
}
