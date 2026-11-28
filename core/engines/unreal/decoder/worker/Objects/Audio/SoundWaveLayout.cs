using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Versions;

namespace AssetViewer.UnrealDecode.Objects.Audio;

internal sealed record AudioExport(string Format, long Size);
internal sealed record AudioBulkSlice(long Size, Func<int, byte[]> Read);

internal static class SoundWaveLayout
{
    private static InputException Invalid() => new("layout");

    public static (byte[] Bytes, string Format) Read(FAssetArchive archive, long remaining, Func<long, AudioBulkSlice> readBulk)
    {
        bool? streaming = null;
        bool? loading = null;
        TaggedProperties.Read(archive, tag =>
        {
            switch (tag.Name.Text)
            {
                case "bStreaming":
                    if (streaming != null) throw Invalid();
                    streaming = TaggedProperties.TaggedBoolean(tag);
                    break;
                case "LoadingBehavior":
                    if (loading != null || tag.ArrayIndex != 0 || tag.Size != 8 ||
                        tag.PropertyType.Text is not ("ByteProperty" or "EnumProperty") ||
                        tag.SerializeType != EPropertyTagSerializeType.Property) throw Invalid();
                    var name = archive.ReadFName();
                    loading = !name.IsNone && name.Text is not ("ESoundWaveLoadingBehavior::ForceInline" or "ForceInline");
                    break;
            }
        });
        if (TaggedProperties.Boolean(archive)) archive.Position += 16; // UObject GUID
        var flags = archive.Read<uint>();
        if ((flags & 1) == 0 || (flags & ~31u) != 0) throw new InputException("platform");
        if (archive.Game >= EGame.GAME_UE5_4 && archive.Read<int>() != 0) throw new InputException("cue-points");
        remaining = Math.Min(remaining, 32 * 1024 * 1024);
        return (streaming ?? loading ?? archive.Versions["SoundWave.UseAudioStreaming"])
            ? ReadStream(archive, remaining, readBulk) : ReadInline(archive, remaining, readBulk);
    }

    private static (byte[], string) ReadInline(FAssetArchive archive, long remaining, Func<long, AudioBulkSlice> readBulk)
    {
        var count = archive.Read<int>();
        if (count is < 1 or > 8) throw Invalid();
        string? format = null;
        AudioBulkSlice? selected = null;
        for (var i = 0; i < count; i++)
        {
            var candidate = AudioFormat(archive.ReadFName().Text);
            var payload = readBulk(archive.Length - 16);
            if (candidate == null || selected != null || payload.Size == 0) continue;
            (format, selected) = (candidate, payload);
        }
        archive.Position += 16; // CompressedDataGuid
        if (archive.Position != archive.Length) throw Invalid();
        if (selected == null || format == null) throw new InputException("format");
        if (selected.Size > remaining) throw new InputException("limit");
        return (selected.Read((int)selected.Size), format);
    }

    private static (byte[], string) ReadStream(FAssetArchive archive, long remaining, Func<long, AudioBulkSlice> readBulk)
    {
        archive.Position += 16; // CompressedDataGuid
        var count = archive.Read<int>();
        if (count is < 1 or > 512) throw Invalid();
        var format = AudioFormat(archive.ReadFName().Text) ?? throw new InputException("format");
        var chunks = new (AudioBulkSlice Payload, int Length)[count];
        long total = 0;
        for (var i = 0; i < count; i++)
        {
            var flags = archive.Read<uint>();
            if ((flags & 1) == 0 || (flags & ~7u) != 0) throw Invalid();
            var payload = readBulk(archive.Length - ((flags & 2) != 0 ? 12 : 8));
            var stored = archive.Read<int>();
            var length = archive.Read<int>();
            if ((flags & 2) != 0) _ = archive.Read<uint>();
            if (length <= 0 || stored < length || stored > payload.Size) throw Invalid();
            total += length;
            if (total > remaining) throw new InputException("limit");
            chunks[i] = (payload, length);
        }
        if (archive.Position != archive.Length) throw Invalid();
        var result = new byte[(int)total];
        var offset = 0;
        foreach (var (payload, length) in chunks)
        {
            payload.Read(length).CopyTo(result, offset);
            offset += length;
        }
        return (result, format);
    }

    private static string? AudioFormat(string name) => name.Split('_', 2)[0].ToUpperInvariant() switch
    {
        "OGG" => "ogg",
        "PCM" => "wav",
        _ => null,
    };
}
