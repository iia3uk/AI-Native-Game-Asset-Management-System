using System.Buffers.Binary;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;

namespace AssetViewer.UnrealDecode.Objects;

internal sealed record CookedInput(string Path, long Size);

internal static class CookedPackage
{
    private const int MaxHeader = 16 * 1024 * 1024;
    public const int MaxFile = 64 * 1024 * 1024;

    public static TResult? Read<TExport, TResult>(CookedInput? input, CookedInput? exports, CookedInput? bulk,
        CookedInput? optional, string className, string issuePrefix, Func<TExport, Package, TResult> decode)
        where TExport : UObject
        => ReadCore(input, exports, bulk, optional, className, issuePrefix, (package, selected, _, _) =>
            package.ExportsLazy[selected].Value is TExport asset
                ? decode(asset, package) : throw new InputException(issuePrefix + "-layout"));

    public static TResult? ReadRaw<TResult>(CookedInput? input, CookedInput? exports,
        string className, string issuePrefix, Func<byte[], FAssetArchive, TResult> decode)
        => ReadCore(input, exports, null, null, className, issuePrefix, (package, selected, header, data) =>
        {
            var export = package.ExportMap[selected];
            var source = data ?? header;
            source.Position = export.SerialOffset - (data == null ? 0 : package.Summary.TotalHeaderSize);
            var bytes = source.ReadBytes((int)export.SerialSize);
            using var buffer = new FByteArchive(className, bytes, source.Versions);
            using var archive = new FAssetArchive(buffer, package, (int)export.SerialOffset);
            return decode(bytes, archive);
        });

    private static TResult? ReadCore<TResult>(CookedInput? input, CookedInput? exports, CookedInput? bulk,
        CookedInput? optional, string className, string issuePrefix, Func<Package, int, FByteArchive, FByteArchive?, TResult> decode)
    {
        if (input is not { Size: >= 64 and <= MaxFile } || !HasStockHeader(input)) return default;
        try
        {
            var version = new VersionContainer(EGame.GAME_UE4_27);
            using var header = Archive("Asset.uasset", input, version)!;
            using var data = Archive("Asset.uexp", exports, version);
            using var payload = Archive("Asset.ubulk", bulk, version);
            using var optionalPayload = Archive("Asset.uptnl", optional, version);
            var package = new Package(header, data, payload, optionalPayload);
            var selected = -1;
            for (var i = 0; i < package.ExportMap.Length; i++)
            {
                var export = package.ExportMap[i];
                if (export.OuterIndex?.Index != 0 || export.ClassIndex is not { } classIndex ||
                    !IsNativeClass(package, classIndex.Index, className)) continue;
                if (selected >= 0) throw new InputException(issuePrefix + "-ambiguous");
                var minimum = package.Summary.TotalHeaderSize;
                var maximum = data == null ? header.Length : minimum + data.Length;
                if (export.SerialOffset < minimum || export.SerialSize <= 0 || export.SerialOffset > maximum - export.SerialSize)
                    throw new InputException(issuePrefix + "-layout");
                selected = i;
            }
            if (selected < 0) return default;
            return decode(package, selected, header, data);
        }
        catch (Exception error) when (error is not InputException and not OutOfMemoryException and not IOException)
        {
            throw new InputException(issuePrefix + "-layout");
        }
    }

    private static bool HasStockHeader(CookedInput input)
    {
        using var stream = File.OpenRead(input.Path);
        Span<byte> prefix = stackalloc byte[24];
        stream.ReadExactly(prefix);
        if (U32(prefix) != 0x9E2A83C1 || I32(prefix[4..]) != -7 || I32(prefix[12..]) != 522 || I32(prefix[16..]) != 0) return false;
        var customVersions = I32(prefix[20..]);
        if (customVersions is < 0 or > 256 || stream.Length < 64 + 20 * customVersions) return false;
        stream.Position = 24 + customVersions * 20;
        stream.ReadExactly(prefix[..8]);
        var header = I32(prefix);
        var nameLength = I32(prefix[4..]);
        var nameBytes = nameLength >= 0 ? nameLength : -2L * nameLength;
        if (header > MaxHeader || header > stream.Length || nameBytes > 4096 || stream.Position + nameBytes + 40 > header) return false;
        stream.Position += nameBytes;
        Span<byte> tables = stackalloc byte[40];
        stream.ReadExactly(tables);
        var flags = U32(tables);
        // FilterEditorOnly removes the localization ID and per-import editor package name.
        if ((flags & 0x80000200) != 0x80000200 || (flags & 0x00002000) != 0) return false;
        var nameCount = I32(tables[4..]);
        var nameOffset = I32(tables[8..]);
        var exportCount = I32(tables[20..]);
        var exportOffset = I32(tables[24..]);
        var importCount = I32(tables[28..]);
        var importOffset = I32(tables[32..]);
        return nameCount is > 0 and <= 32_768 && exportCount is > 0 and <= 4096 && importCount is > 0 and <= 8192 &&
            nameOffset >= stream.Position && nameOffset <= importOffset && importOffset - nameOffset >= nameCount * 8 &&
            exportOffset >= importOffset && exportOffset <= header &&
            exportOffset - importOffset == importCount * 28 && header - exportOffset >= exportCount * 104;
    }

    private static uint U32(ReadOnlySpan<byte> value) => BinaryPrimitives.ReadUInt32LittleEndian(value);
    private static int I32(ReadOnlySpan<byte> value) => BinaryPrimitives.ReadInt32LittleEndian(value);

    private static FByteArchive? Archive(string name, CookedInput? input, VersionContainer version) =>
        input is { Size: > 0 and <= MaxFile } ? new FByteArchive(name, File.ReadAllBytes(input.Path), version) : null;

    private static bool IsNativeClass(Package package, int index, string className)
    {
        var i = -1L - index;
        if (index >= 0 || i >= package.ImportMap.Length) return false;
        var type = package.ImportMap[i];
        if (type.OuterIndex is not { } typeOwner) return false;
        var outer = -1L - typeOwner.Index;
        if (type.ClassName.Text != "Class" || type.ObjectName.Text != className || outer < 0 || outer >= package.ImportMap.Length) return false;
        var owner = package.ImportMap[outer];
        return owner.ClassName.Text == "Package" && owner.ObjectName.Text == "/Script/Engine" && owner.OuterIndex?.Index == 0;
    }
}
