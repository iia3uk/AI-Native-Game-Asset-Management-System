using AssetViewer.Formats;
using CUE4Parse.UE4.Assets.Exports.Texture;

namespace AssetViewer.UnrealDecode.Objects;

internal static class TexturePixels
{
    public const int Revision = 3;
    public const int MaxSide = 4096;

    public static bool Supports(EPixelFormat format) =>
        format is EPixelFormat.PF_B8G8R8A8 or EPixelFormat.PF_R8G8B8A8 or EPixelFormat.PF_G8 or
            EPixelFormat.PF_DXT1 or EPixelFormat.PF_DXT5 or EPixelFormat.PF_BC4 or EPixelFormat.PF_BC5 or EPixelFormat.PF_BC7;

    public static int Size(EPixelFormat format, int width, int height) => format switch
    {
        EPixelFormat.PF_DXT1 or EPixelFormat.PF_BC4 => BlockCompression.Size(width, height, false),
        EPixelFormat.PF_DXT5 or EPixelFormat.PF_BC5 or EPixelFormat.PF_BC7 => BlockCompression.Size(width, height, true),
        EPixelFormat.PF_G8 => width * height,
        _ => 4 * width * height,
    };

    public static (byte[] Data, TextureExport Export) Decode(byte[] bytes, EPixelFormat format, int width, int height,
        int mip, bool srgb, bool normalMap, string issuePrefix)
    {
        var reconstructNormalZ = format == EPixelFormat.PF_BC5 && normalMap;
        var linear = format is EPixelFormat.PF_BC4 or EPixelFormat.PF_BC5;
        return (Expand(bytes, format, width, height, reconstructNormalZ, issuePrefix),
            new TextureExport(width, height, mip, format.ToString(), !linear && srgb, reconstructNormalZ));
    }

    private static byte[] Expand(byte[] bytes, EPixelFormat format, int width, int height, bool normalMap, string issuePrefix) => format switch
    {
        EPixelFormat.PF_DXT1 => BlockCompression.Decode(bytes, width, height, false),
        EPixelFormat.PF_DXT5 => BlockCompression.Decode(bytes, width, height, true),
        EPixelFormat.PF_BC4 => BlockCompression.DecodeChannels(bytes, width, height, false, false),
        EPixelFormat.PF_BC5 => BlockCompression.DecodeChannels(bytes, width, height, true, normalMap),
        EPixelFormat.PF_BC7 => Bc7Texture.Decode(bytes, width, height, issuePrefix),
        EPixelFormat.PF_B8G8R8A8 => Swizzle(bytes),
        EPixelFormat.PF_G8 => ExpandGray(bytes),
        _ => bytes,
    };

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
