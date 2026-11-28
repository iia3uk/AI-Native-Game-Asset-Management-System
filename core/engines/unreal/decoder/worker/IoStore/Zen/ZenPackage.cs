using System.Buffers.Binary;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.IO.Objects;
using CUE4Parse.UE4.Objects.Core.Serialization;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;

namespace AssetViewer.UnrealDecode.IoStore.Zen;

internal sealed class ZenPackage(FNameEntrySerialized[] names, EPackageFlags flags, VersionContainer version,
    FBulkDataMapEntry[] bulk, int offset, int size) : AbstractUePackage("Zen.uasset", null)
{
    private static readonly ulong TextureClass = ScriptClass("texture2d");
    private static readonly ulong SoundWaveClass = ScriptClass("soundwave");
    private static readonly ulong StaticMeshClass = ScriptClass("staticmesh");
    private const int HeaderLimit = 16 * 1024 * 1024;

    public override FPackageFileSummary Summary { get; } = new() { PackageFlags = flags };
    public override FNameEntrySerialized[] NameMap => names;
    public override int ImportMapLength => 0;
    public override int ExportMapLength => 0;
    public override int GetExportIndex(string name, StringComparison comparisonType) => -1;
    public override ResolvedObject? ResolvePackageIndex(FPackageIndex? index) => null;
    public VersionContainer Version => version;
    public FBulkDataMapEntry[] Bulk => bulk;
    public int Offset => offset;
    public int Size => size;

    public static ZenPackage? Read(byte[] bytes, ulong packageId, out ZenExportKind kind)
    {
        kind = ZenExportKind.None;
        if (bytes.Length < 72 || U32(bytes) != 1 || U32(bytes.AsSpan(52)) != 3 ||
            U32(bytes.AsSpan(56)) != 522 || U32(bytes.AsSpan(64)) != 0) return null;
        var game = U32(bytes.AsSpan(60)) switch
        {
            1009 => EGame.GAME_UE5_3,
            1012 => EGame.GAME_UE5_4,
            _ => (EGame?)null,
        };
        if (game == null) return null;
        var version = new VersionContainer(game.Value);
        using var archive = new FByteArchive("Zen.uasset", bytes, version);
        var header = new FZenPackageSummary(archive);
        const EPackageFlags cooked = EPackageFlags.PKG_Cooked | EPackageFlags.PKG_FilterEditorOnly;
        if ((header.PackageFlags & cooked) != cooked) return null;

        var customCount = U32(bytes.AsSpan(68));
        var namesAt = 72L + 20 * customCount;
        var exportBytes = (long)header.ExportBundleEntriesOffset - header.ExportMapOffset;
        var count = exportBytes / FExportMapEntry.Size;
        if (header.HeaderSize > Math.Min(bytes.Length, HeaderLimit) || customCount > 256 ||
            namesAt + 16 > header.ImportedPublicExportHashesOffset ||
            header.ImportedPublicExportHashesOffset > header.ImportMapOffset || header.ImportMapOffset > header.ExportMapOffset ||
            count is < 1 or > 4096 || exportBytes % FExportMapEntry.Size != 0 ||
            header.ExportBundleEntriesOffset + count * 16 > header.DependencyBundleHeadersOffset ||
            header.DependencyBundleHeadersOffset > header.DependencyBundleEntriesOffset ||
            header.DependencyBundleEntriesOffset > header.ImportedPackageNamesOffset ||
            header.ImportedPackageNamesOffset > header.HeaderSize) return null;

        // Only native top-level exports with a supported serialization are eligible.
        archive.Position = header.ExportMapOffset;
        int selected = -1;
        FExportMapEntry target = default;
        for (var i = 0; i < count; i++)
        {
            var entry = new FExportMapEntry(archive);
            if (!entry.OuterIndex.IsNull ||
                entry.ObjectFlags.HasFlag(EObjectFlags.RF_ClassDefaultObject)) continue;
            var exportKind = entry.ClassIndex.TypeAndId == TextureClass ? ZenExportKind.Texture :
                entry.ClassIndex.TypeAndId == SoundWaveClass ? ZenExportKind.SoundWave :
                entry.ClassIndex.TypeAndId == StaticMeshClass ? ZenExportKind.StaticMesh : ZenExportKind.None;
            if (exportKind == ZenExportKind.None) continue;
            if (selected >= 0) throw new InputException("ambiguous");
            kind = exportKind;
            selected = i;
            target = entry;
        }
        if (selected < 0) return null;
        if (header.PackageFlags.HasFlag(EPackageFlags.PKG_UnversionedProperties))
            throw new InputException("unversioned");
        if (target.CookedSerialOffset > int.MaxValue || target.CookedSerialSize is 0 or > HeaderLimit ||
            header.HeaderSize + target.CookedSerialOffset + target.CookedSerialSize > (ulong)bytes.Length)
            throw Invalid();

        archive.Position = header.ExportBundleEntriesOffset;
        var commands = 0;
        for (var i = 0; i < count * 2; i++)
        {
            var index = archive.Read<uint>();
            var command = archive.Read<uint>();
            if (index >= count || command > 1) throw Invalid();
            if (index != selected) continue;
            var bit = 1 << (int)command;
            if ((commands & bit) != 0) throw Invalid();
            commands |= bit;
        }
        if (commands != 3) throw Invalid();

        archive.Position = 68;
        version.CustomVersions = new FCustomVersionContainer(archive);
        if (archive.Position != namesAt) throw Invalid();
        var names = ReadNames(archive, bytes, (int)namesAt, header.ImportedPublicExportHashesOffset);
        if (header.Name.IsGlobal || header.Name.ExtraIndex != 0 || header.Name.NameIndex >= names.Length ||
            target.ObjectName.IsGlobal || target.ObjectName.NameIndex >= names.Length ||
            names[header.Name.NameIndex].Name is not { Length: > 1 } packageName || packageName[0] != '/' ||
            FPackageId.FromName(packageName).id != packageId) throw Invalid();
        var bulk = ReadBulk(archive, game.Value, header.ImportedPublicExportHashesOffset);
        return new(names, header.PackageFlags, version, bulk,
            (int)(header.HeaderSize + target.CookedSerialOffset), (int)target.CookedSerialSize);
    }

    private static FNameEntrySerialized[] ReadNames(FByteArchive archive, byte[] bytes, int start, int boundary)
    {
        var count = U32(bytes.AsSpan(start));
        var size = U32(bytes.AsSpan(start + 4));
        var headersAt = start + 16L + 8 * count;
        var stringsAt = headersAt + 2 * count;
        if (count is 0 or > 32768 || size > HeaderLimit || stringsAt + size > boundary) throw Invalid();
        var used = 0;
        for (var at = (int)headersAt; at < stringsAt; at += 2)
        {
            var length = ((bytes[at] & 127) << 8) | bytes[at + 1];
            if (length is 0 or > 4096) throw Invalid();
            used += (bytes[at] & 128) == 0 ? length : length * 2;
        }
        if (used != size) throw Invalid();
        archive.Position = start;
        return FNameEntrySerialized.LoadNameBatch(archive);
    }

    private static FBulkDataMapEntry[] ReadBulk(FByteArchive archive, EGame game, int boundary)
    {
        if (game >= EGame.GAME_UE5_4)
        {
            if (archive.Position + 8 > boundary) throw Invalid();
            var pad = archive.Read<ulong>();
            if (pad > 15) throw Invalid();
            archive.Position += (int)pad;
        }
        if (archive.Position + 8 > boundary) throw Invalid();
        var length = archive.Read<long>();
        if (length is < 0 or > 32768 || length % FBulkDataMapEntry.Size != 0 || archive.Position + length != boundary)
            throw Invalid();
        return archive.ReadArray<FBulkDataMapEntry>((int)(length / FBulkDataMapEntry.Size));
    }

    private static uint U32(ReadOnlySpan<byte> value) => BinaryPrimitives.ReadUInt32LittleEndian(value);
    private static ulong ScriptClass(string name) => (1UL << FPackageObjectIndex.TypeShift) |
        (FPackageId.FromName("/script/engine/" + name).id & FPackageObjectIndex.IndexMask);
    internal static InputException Invalid() => new("layout");
}

internal enum ZenExportKind { None, Texture, SoundWave, StaticMesh }
