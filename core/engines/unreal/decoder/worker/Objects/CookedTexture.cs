using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Objects.Engine;

namespace AssetViewer.UnrealDecode.Objects;

internal static class CookedTexture
{
    public static (byte[] Data, TextureExport Export)? Read(CookedInput? input, CookedInput? exports, CookedInput? bulk,
        CookedInput? optional, long remaining)
        => CookedPackage.Read<UTexture2D, (byte[], TextureExport)?>(input, exports, bulk, optional,
            "Texture2D", "unreal-cooked-texture", (texture, _) => GetPixels(texture, remaining));

    private static bool ValidDimensions(FTexture2DMipMap level) =>
        level.SizeX is > 0 and <= TexturePixels.MaxSide && level.SizeY is > 0 and <= TexturePixels.MaxSide && level.SizeZ == 1;

    private static (byte[] Data, TextureExport Export) GetPixels(UTexture2D texture, long remaining)
    {
        var platform = texture.PlatformData;
        var format = texture.Format;
        if (platform.VTData != null || platform.PackedData != 1 || platform.Mips.Length is < 1 or > 16 ||
            platform.FirstMipToSerialize is < 0 or > 15 || platform.PixelFormat != format.ToString() ||
            !TexturePixels.Supports(format))
            throw new InputException("unreal-cooked-texture-format");
        for (var i = 0; i < platform.Mips.Length; i++)
        {
            var mip = platform.Mips[i];
            if (!ValidDimensions(mip) || mip.BulkData is not { } bulk || bulk.Header.ElementCount == 0) continue;
            var width = mip.SizeX;
            var height = mip.SizeY;
            var length = 4 * width * height;
            var expected = TexturePixels.Size(format, width, height);
            if (bulk.Header.ElementCount != expected || bulk.Header.SizeOnDisk is 0 or > CookedPackage.MaxFile)
                throw new InputException("unreal-cooked-texture-mip");
            if (length > remaining) throw new InputException("unreal-cooked-texture-limit");
            if (bulk.Data is not { Length: > 0 } bytes) continue;
            if (bytes.Length != expected) throw new InputException("unreal-cooked-texture-mip");
            return TexturePixels.Decode(bytes, format, width, height, platform.FirstMipToSerialize + i,
                texture.SRGB, texture.IsNormalMap, "unreal-cooked-texture-");
        }
        throw new InputException("unreal-cooked-texture-mip");
    }

}
