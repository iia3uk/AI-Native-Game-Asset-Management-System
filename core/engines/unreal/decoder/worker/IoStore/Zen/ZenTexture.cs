using AssetViewer.UnrealDecode.Objects;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;

namespace AssetViewer.UnrealDecode.IoStore.Zen;

internal static class ZenTexture
{
    public static (byte[] Data, TextureExport Export)? Read(string path, ulong packageId,
        IReadOnlyDictionary<string, string> sidecars, long remaining)
    {
        try
        {
            var chunk = File.ReadAllBytes(path);
            var package = ZenPackage.Read(chunk, packageId);
            if (package == null) return null;
            var bytes = chunk.AsSpan(package.Offset, package.Size).ToArray();
            using var source = new FByteArchive("Texture2D", bytes, package.Version);
            using var archive = new FAssetArchive(source, package);
            var srgb = ReadColorSpace(archive);
            if (Boolean(archive)) archive.Position += 16; // UObject GUID
            var strips = archive.Read<ushort>();
            _ = archive.Read<ushort>();
            if ((strips & 1) == 0 || !Boolean(archive) || !Boolean(archive))
                throw new InputException("unreal-iostore-texture-platform");

            var name = archive.ReadFName();
            if (!Enum.TryParse(name.Text, out EPixelFormat format) || !TexturePixels.Supports(format))
                throw new InputException("unreal-iostore-texture-format");
            var at = archive.Position;
            var skip = archive.Read<long>();
            if (skip < 8 || skip > bytes.Length - at - 8) throw ZenPackage.Invalid();
            var end = at + skip;
            var image = ReadPlatform(archive, package, bytes, sidecars, format, end, srgb, remaining);
            // Subsequent platform variants are bounded by their relative end offsets.
            while (!archive.ReadFName().IsNone)
            {
                at = archive.Position;
                skip = archive.Read<long>();
                if (skip < 8 || skip > bytes.Length - at - 8) throw ZenPackage.Invalid();
                archive.Position = at + skip;
            }
            if (archive.Position != bytes.Length) throw ZenPackage.Invalid();
            return image;
        }
        catch (Exception error) when (error is not (InputException or OutOfMemoryException))
        {
            throw ZenPackage.Invalid();
        }
    }

    private static bool ReadColorSpace(FAssetArchive archive)
    {
        var srgb = true;
        var seen = false;
        if (archive.Ver >= EUnrealEngineObjectUE5Version.PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION &&
            archive.Read<byte>() != 0) throw new InputException("unreal-iostore-texture-property-layout");
        for (var i = 0; i < 2048; i++)
        {
            var tag = new FPropertyTag(archive, false);
            if (tag.Name.IsNone) return srgb;
            if (tag.Size < 0 || tag.Size > archive.Length - archive.Position) throw ZenPackage.Invalid();
            if (tag.Name.Text.Equals("SRGB", StringComparison.OrdinalIgnoreCase))
            {
                if (seen || tag.PropertyType.Text != "BoolProperty" || tag.ArrayIndex != 0 || tag.Size != 0 ||
                    tag.TagData?.Bool is not bool colorSpace || tag.SerializeType != EPropertyTagSerializeType.Property)
                    throw ZenPackage.Invalid();
                srgb = colorSpace;
                seen = true;
            }
            archive.Position += tag.Size;
        }
        throw ZenPackage.Invalid();
    }

    private static (byte[] Data, TextureExport Export) ReadPlatform(FAssetArchive archive, ZenPackage package, byte[] bytes,
        IReadOnlyDictionary<string, string> sidecars, EPixelFormat format, long end, bool srgb, long remaining)
    {
        if (archive.Read<byte>() != 0) throw new InputException("unreal-iostore-texture-derived-data");
        archive.Position += 15; // placeholder FDerivedData
        var width = archive.Read<int>();
        var height = archive.Read<int>();
        if (width <= 0 || height <= 0 || archive.Read<uint>() != 1)
            throw new InputException("unreal-iostore-texture-platform");
        var nameSize = archive.Read<int>();
        if (nameSize is < 2 or > 64 || nameSize > end - archive.Position) throw ZenPackage.Invalid();
        var name = System.Text.Encoding.ASCII.GetString(archive.ReadBytes(nameSize));
        if (name != format + "\0") throw ZenPackage.Invalid();
        var first = archive.Read<int>();
        var count = archive.Read<int>();
        if (first is < 0 or > 15 || count is < 1 or > 16) throw ZenPackage.Invalid();
        var mips = new ZenMip[count];
        for (var i = 0; i < count; i++) mips[i] = ZenMip.Read(archive, package.Bulk, end);
        if (Boolean(archive)) throw new InputException("unreal-iostore-texture-virtual");
        if (archive.Position != end) throw ZenPackage.Invalid();

        for (var i = 0; i < count; i++)
        {
            var mip = mips[i];
            if (mip.Width <= 0 || mip.Height <= 0 || mip.Width > width || mip.Height > height || mip.Depth != 1)
                throw ZenPackage.Invalid();
            if (mip.Size == 0 || mip.Width > TexturePixels.MaxSide || mip.Height > TexturePixels.MaxSide) continue;
            if (mip.Size != TexturePixels.Size(format, mip.Width, mip.Height)) throw ZenPackage.Invalid();
            if (4L * mip.Width * mip.Height > remaining) throw new InputException("unreal-iostore-texture-limit");
            var data = mip.Pixels(bytes, sidecars);
            if (data != null) return (TexturePixels.Decode(data, format, mip.Width, mip.Height),
                new TextureExport(mip.Width, mip.Height, first + i, format.ToString(), srgb));
        }
        throw new InputException("unreal-iostore-texture-mip-unavailable");
    }

    private static bool Boolean(FAssetArchive archive) => archive.Read<int>() switch
    {
        0 => false,
        1 => true,
        _ => throw ZenPackage.Invalid(),
    };
}
