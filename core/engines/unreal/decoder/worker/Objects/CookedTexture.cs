using System.Buffers.Binary;
using AssetViewer.Formats;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Objects.Engine;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;

namespace AssetViewer.UnrealDecode.Objects;

internal sealed record CookedInput(string Path, long Size);

internal static class CookedTexture
{
    private const int MaxSide = 4096;
    private const int MaxHeader = 16 * 1024 * 1024;
    private const int MaxFile = 64 * 1024 * 1024;

    public static (byte[] Data, TextureExport Export)? Read(CookedInput? input, CookedInput? exports, CookedInput? bulk,
        CookedInput? optional, long remaining)
    {
        if (input is not { Size: >= 64 and <= MaxFile } || !HasStockHeader(input)) return null;
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
                if (export.OuterIndex?.Index != 0 || export.ClassIndex is not { } classIndex || !IsTextureImport(package, classIndex.Index)) continue;
                if (selected >= 0) throw new InputException("unreal-cooked-texture-ambiguous");
                var minimum = package.Summary.TotalHeaderSize;
                var maximum = data == null ? header.Length : minimum + data.Length;
                if (export.SerialOffset < minimum || export.SerialSize <= 0 || export.SerialOffset > maximum - export.SerialSize)
                    throw new InputException("unreal-cooked-texture-layout");
                selected = i;
            }
            if (selected < 0) return null;
            if (package.ExportsLazy[selected].Value is not UTexture2D texture)
                throw new InputException("unreal-cooked-texture-layout");
            return GetPixels(texture, remaining);
        }
        catch (Exception error) when (error is not InputException)
        {
            throw new InputException("unreal-cooked-texture-layout");
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

    private static bool IsTextureImport(Package package, int index)
    {
        var i = -1L - index;
        if (index >= 0 || i >= package.ImportMap.Length) return false;
        var type = package.ImportMap[i];
        if (type.OuterIndex is not { } typeOwner) return false;
        var outer = -1L - typeOwner.Index;
        if (type.ClassName.Text != "Class" || type.ObjectName.Text != "Texture2D" || outer < 0 || outer >= package.ImportMap.Length) return false;
        var owner = package.ImportMap[outer];
        return owner.ClassName.Text == "Package" && owner.ObjectName.Text == "/Script/Engine" && owner.OuterIndex?.Index == 0;
    }

    private static bool ValidDimensions(FTexture2DMipMap level) =>
        level.SizeX is > 0 and <= MaxSide && level.SizeY is > 0 and <= MaxSide && level.SizeZ == 1;

    private static (byte[] Data, TextureExport Export) GetPixels(UTexture2D texture, long remaining)
    {
        var platform = texture.PlatformData;
        var format = texture.Format;
        if (platform.VTData != null || platform.PackedData != 1 || platform.Mips.Length is < 1 or > 16 ||
            platform.FirstMipToSerialize is < 0 or > 15 || platform.PixelFormat != format.ToString() ||
            format is not (EPixelFormat.PF_B8G8R8A8 or EPixelFormat.PF_R8G8B8A8 or EPixelFormat.PF_G8 or EPixelFormat.PF_DXT1 or EPixelFormat.PF_DXT5))
            throw new InputException("unreal-cooked-texture-format");
        for (var i = 0; i < platform.Mips.Length; i++)
        {
            var mip = platform.Mips[i];
            if (!ValidDimensions(mip) || mip.BulkData is not { } bulk || bulk.Header.ElementCount == 0) continue;
            var width = mip.SizeX;
            var height = mip.SizeY;
            var count = checked(width * height);
            var length = 4 * count;
            var expected = format switch
            {
                EPixelFormat.PF_DXT1 => BlockCompression.Size(width, height, false),
                EPixelFormat.PF_DXT5 => BlockCompression.Size(width, height, true),
                EPixelFormat.PF_G8 => count,
                _ => length,
            };
            if (bulk.Header.ElementCount != expected || bulk.Header.SizeOnDisk is 0 or > MaxFile)
                throw new InputException("unreal-cooked-texture-mip");
            if (length > remaining) throw new InputException("unreal-cooked-texture-limit");
            if (bulk.Data is not { Length: > 0 } bytes) continue;
            if (bytes.Length != expected) throw new InputException("unreal-cooked-texture-mip");
            var result = format switch
            {
                EPixelFormat.PF_DXT1 => BlockCompression.Decode(bytes, width, height, false),
                EPixelFormat.PF_DXT5 => BlockCompression.Decode(bytes, width, height, true),
                EPixelFormat.PF_B8G8R8A8 => Swizzle(bytes),
                EPixelFormat.PF_G8 => ExpandGray(bytes),
                _ => bytes,
            };
            return (result, new TextureExport(width, height, platform.FirstMipToSerialize + i, format.ToString(), texture.SRGB));
        }
        throw new InputException("unreal-cooked-texture-mip");
    }

    private static byte[] Swizzle(byte[] bytes)
    {
        for (var i = 0; i < bytes.Length; i += 4) (bytes[i], bytes[i + 2]) = (bytes[i + 2], bytes[i]);
        return bytes;
    }

    private static byte[] ExpandGray(byte[] bytes)
    {
        var pixels = new byte[bytes.Length * 4];
        for (var i = 0; i < bytes.Length; i++)
        {
            var at = 4 * i;
            pixels[at] = pixels[at + 1] = pixels[at + 2] = bytes[i];
            pixels[at + 3] = 255;
        }
        return pixels;
    }
}
