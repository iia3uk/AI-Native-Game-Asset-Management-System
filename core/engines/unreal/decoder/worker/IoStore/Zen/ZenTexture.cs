using AssetViewer.UnrealDecode.Objects;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Readers;
using static AssetViewer.UnrealDecode.Objects.TaggedProperties;

namespace AssetViewer.UnrealDecode.IoStore.Zen;

internal static class ZenTexture
{
    public static (byte[] Data, TextureExport Export) Read(byte[] bytes, ZenPackage package,
        IReadOnlyDictionary<string, string> sidecars, long remaining)
    {
        using var source = new FByteArchive("Texture2D", bytes, package.Version);
        using var archive = new FAssetArchive(source, package);
        var srgb = ReadColorSpace(archive);
        if (Boolean(archive)) archive.Position += 16; // UObject GUID
        var strips = archive.Read<ushort>();
        _ = archive.Read<ushort>();
        if ((strips & 1) == 0 || !Boolean(archive) || !Boolean(archive))
            throw new InputException("platform");

        var name = archive.ReadFName();
        if (!Enum.TryParse(name.Text, out EPixelFormat format) || !TexturePixels.Supports(format))
            throw new InputException("format");
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

    private static bool ReadColorSpace(FAssetArchive archive)
    {
        var srgb = true;
        var seen = false;
        TaggedProperties.Read(archive, tag =>
        {
            if (!tag.Name.Text.Equals("SRGB", StringComparison.OrdinalIgnoreCase)) return;
            if (seen) throw ZenPackage.Invalid();
            srgb = TaggedBoolean(tag);
            seen = true;
        });
        return srgb;
    }

    private static (byte[] Data, TextureExport Export) ReadPlatform(FAssetArchive archive, ZenPackage package, byte[] bytes,
        IReadOnlyDictionary<string, string> sidecars, EPixelFormat format, long end, bool srgb, long remaining)
    {
        if (archive.Read<byte>() != 0) throw new InputException("derived-data");
        archive.Position += 15; // placeholder FDerivedData
        var width = archive.Read<int>();
        var height = archive.Read<int>();
        if (width <= 0 || height <= 0 || archive.Read<uint>() != 1)
            throw new InputException("platform");
        var nameSize = archive.Read<int>();
        if (nameSize is < 2 or > 64 || nameSize > end - archive.Position) throw ZenPackage.Invalid();
        var name = System.Text.Encoding.ASCII.GetString(archive.ReadBytes(nameSize));
        if (name != format + "\0") throw ZenPackage.Invalid();
        var first = archive.Read<int>();
        var count = archive.Read<int>();
        if (first is < 0 or > 15 || count is < 1 or > 16) throw ZenPackage.Invalid();
        var mips = new ZenMip[count];
        for (var i = 0; i < count; i++) mips[i] = ZenMip.Read(archive, package.Bulk, end);
        if (Boolean(archive)) throw new InputException("virtual");
        if (archive.Position != end) throw ZenPackage.Invalid();

        for (var i = 0; i < count; i++)
        {
            var mip = mips[i];
            if (mip.Width <= 0 || mip.Height <= 0 || mip.Width > width || mip.Height > height || mip.Depth != 1)
                throw ZenPackage.Invalid();
            if (mip.Payload.Size == 0 || mip.Width > TexturePixels.MaxSide || mip.Height > TexturePixels.MaxSide) continue;
            var size = TexturePixels.Size(format, mip.Width, mip.Height);
            if (mip.Payload.Size != size) throw ZenPackage.Invalid();
            if (4L * mip.Width * mip.Height > remaining) throw new InputException("limit");
            var data = mip.Payload.ReadBytes(bytes, sidecars, size);
            if (data != null) return (TexturePixels.Decode(data, format, mip.Width, mip.Height),
                new TextureExport(mip.Width, mip.Height, first + i, format.ToString(), srgb));
        }
        throw new InputException("mip-unavailable");
    }
}
