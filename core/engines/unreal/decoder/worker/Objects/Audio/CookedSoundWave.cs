using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Readers;
using static CUE4Parse.UE4.Assets.Objects.EBulkDataFlags;

namespace AssetViewer.UnrealDecode.Objects.Audio;

internal static class CookedSoundWave
{
    private const string IssuePrefix = "unreal-cooked-audio";
    public const long BatchLimit = 128L * 1024 * 1024;
    public static string Issue(string code) => code.StartsWith(IssuePrefix, StringComparison.Ordinal) ? code : IssuePrefix + "-" + code;

    public static AudioExport? Decode(CookedInput? input, CookedInput? exports, CookedInput? bulk, CookedInput? optional,
        string destinationStem, long remaining)
    {
        var result = CookedPackage.ReadRaw<(byte[] Bytes, string Format)?>(input, exports, "SoundWave", IssuePrefix,
            (bytes, archive) => SoundWaveLayout.Read(archive, remaining, end =>
                ReadBulk(archive, end, bytes, input, exports, bulk, optional)));
        if (result is not { } audio) return null;
        using var output = File.Open(destinationStem + "." + audio.Format, FileMode.CreateNew, FileAccess.Write);
        output.Write(audio.Bytes);
        return new(audio.Format, audio.Bytes.Length);
    }

    private static AudioBulkSlice ReadBulk(FAssetArchive archive, long end, byte[] bytes, CookedInput? input,
        CookedInput? exports, CookedInput? bulk, CookedInput? optional)
    {
        var flags = archive.Read<EBulkDataFlags>();
        const EBulkDataFlags supported = BULKDATA_PayloadAtEndOfFile | BULKDATA_SingleUse | BULKDATA_Unused |
            BULKDATA_ForceInlinePayload | BULKDATA_ForceStreamPayload | BULKDATA_PayloadInSeperateFile |
            BULKDATA_Force_NOT_InlinePayload | BULKDATA_OptionalPayload | BULKDATA_Size64Bit |
            BULKDATA_NoOffsetFixUp | BULKDATA_LazyLoadable;
        var large = flags.HasFlag(BULKDATA_Size64Bit);
        var size = large ? archive.Read<long>() : archive.Read<int>();
        var stored = large ? archive.Read<long>() : archive.Read<uint>();
        var offset = archive.Read<long>();
        if (archive.Position > end || size < 0 || stored != size || size > CookedPackage.MaxFile || (flags & ~supported) != 0)
            throw new InputException("bulk-layout");
        if (flags.HasFlag(BULKDATA_Unused)) return new(0, _ => throw new InputException("bulk-unavailable"));

        if (flags.HasFlag(BULKDATA_ForceInlinePayload) || flags is BULKDATA_None or BULKDATA_LazyLoadable)
        {
            var start = archive.Position;
            if (size > end - start ||
                (flags & (BULKDATA_OptionalPayload | BULKDATA_PayloadInSeperateFile | BULKDATA_Force_NOT_InlinePayload)) != 0)
                throw new InputException("bulk-layout");
            archive.Position += size;
            return new(size, length => bytes.AsSpan((int)start, length).ToArray());
        }

        var summary = archive.Owner!.Summary;
        if (!flags.HasFlag(BULKDATA_NoOffsetFixUp)) offset = checked(offset + summary.BulkDataStartOffset);
        if (flags.HasFlag(BULKDATA_OptionalPayload)) return External(optional, offset, size);
        if (flags.HasFlag(BULKDATA_PayloadInSeperateFile)) return External(bulk, offset, size);
        if (!flags.HasFlag(BULKDATA_PayloadAtEndOfFile) ||
            offset < Math.Max(summary.BulkDataStartOffset, (long)archive.AbsoluteOffset + bytes.Length))
            throw new InputException("bulk-layout");
        return External(exports ?? input, offset - (exports == null ? 0 : summary.TotalHeaderSize), size);
    }

    private static AudioBulkSlice External(CookedInput? input, long offset, long size) => new(size, length =>
    {
        if (input == null) throw new InputException("bulk-unavailable");
        using var stream = File.OpenRead(input.Path);
        if (stream.Length != input.Size || stream.Length > CookedPackage.MaxFile || offset < 0 || offset > stream.Length - size)
            throw new InputException("bulk-range");
        stream.Position = offset;
        var bytes = new byte[length];
        stream.ReadExactly(bytes);
        return bytes;
    });
}
