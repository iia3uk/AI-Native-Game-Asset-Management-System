using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.IO.Objects;
using static CUE4Parse.UE4.Assets.Objects.EBulkDataFlags;

namespace AssetViewer.UnrealDecode.IoStore.Zen;

internal sealed record ZenBulkData(long Size, long Offset, EBulkDataFlags Flags, byte Index)
{
    public static ZenBulkData Read(FAssetArchive archive, FBulkDataMapEntry[] map, long end)
    {
        var token = archive.Read<uint>();
        long size, offset;
        byte index = 0;
        EBulkDataFlags flags;
        if (token < map.Length)
        {
            var entry = map[token];
            flags = (EBulkDataFlags)entry.Flags;
            size = checked((long)entry.SerialSize);
            offset = checked((long)entry.SerialOffset);
            index = entry.CookedIndex.Value;
        }
        else
        {
            flags = (EBulkDataFlags)token;
            var large = flags.HasFlag(BULKDATA_Size64Bit);
            size = large ? archive.Read<long>() : archive.Read<int>();
            var stored = large ? archive.Read<long>() : archive.Read<uint>();
            offset = archive.Read<long>();
            if (size != stored) throw ZenPackage.Invalid();
        }
        const EBulkDataFlags supported = BULKDATA_PayloadAtEndOfFile | BULKDATA_SingleUse | BULKDATA_Unused |
            BULKDATA_ForceInlinePayload | BULKDATA_ForceStreamPayload | BULKDATA_PayloadInSeperateFile |
            BULKDATA_Force_NOT_InlinePayload | BULKDATA_OptionalPayload | BULKDATA_MemoryMappedPayload |
            BULKDATA_Size64Bit | BULKDATA_NoOffsetFixUp | BULKDATA_LazyLoadable;
        if (size < 0 || (flags & ~supported) != 0) throw new InputException("bulk-layout");
        if (size > 0 && !flags.HasFlag(BULKDATA_Unused) && Inline(flags))
        {
            offset = archive.Position;
            if (size > end - offset) throw ZenPackage.Invalid();
            archive.Position += size;
        }
        if (archive.Position > end) throw ZenPackage.Invalid();
        return new(size, offset, flags, index);
    }

    public byte[]? ReadBytes(byte[] export, IReadOnlyDictionary<string, string> sidecars, int length)
    {
        if (Index != 0 || Flags.HasFlag(BULKDATA_Unused)) return null;
        if (length < 0 || length > Size) throw ZenPackage.Invalid();
        if (Inline(Flags)) return export.AsSpan((int)Offset, length).ToArray();
        var extension = Flags switch
        {
            _ when Flags.HasFlag(BULKDATA_OptionalPayload) => ".uptnl",
            _ when Flags.HasFlag(BULKDATA_PayloadInSeperateFile | BULKDATA_MemoryMappedPayload) => ".m.ubulk",
            _ when Flags.HasFlag(BULKDATA_PayloadInSeperateFile) => ".ubulk",
            _ => null,
        };
        if (extension == null || !sidecars.TryGetValue(extension, out var file)) return null;
        using var stream = File.OpenRead(file);
        if (Offset < 0 || Offset > stream.Length - Size) throw new InputException("bulk-range");
        stream.Position = Offset;
        var bytes = new byte[length];
        stream.ReadExactly(bytes);
        return bytes;
    }

    private static bool Inline(EBulkDataFlags flags) =>
        flags.HasFlag(BULKDATA_ForceInlinePayload) || flags is BULKDATA_None or BULKDATA_LazyLoadable;
}
