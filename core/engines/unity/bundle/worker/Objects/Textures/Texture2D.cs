using AssetsTools.NET;
using AssetViewer.Formats;
using AssetViewer.UnityBundle.Objects.Resources;

namespace AssetViewer.UnityBundle.Objects.Textures;

internal sealed record TextureInput(string Name, int Width, int Height, int Dimension, int Count, int Format,
    ReadOnlyMemory<byte> Pixels, ResourceReference? External);

internal static class Texture2D
{
    public static Product Read(AssetTypeValueField field, string member, SerializedResources resources, bool inspectOnly,
        long outputLimit)
    {
        var pixels = field["image data"].AsByteArray;
        var stream = field["m_StreamData"];
        var source = pixels.Length == 0 && !stream.IsDummy && stream["size"].AsUInt != 0
            ? new ResourceReference(stream["path"].AsString, stream["offset"].AsULong, stream["size"].AsUInt)
            : (ResourceReference?)null;
        return Read(new TextureInput(field["m_Name"].AsString, field["m_Width"].AsInt, field["m_Height"].AsInt,
            field["m_TextureDimension"].AsInt, field["m_ImageCount"].AsInt, field["m_TextureFormat"].AsInt,
            pixels, source), member, resources, inspectOnly, outputLimit);
    }

    public static Product Read(TextureInput input, string member, SerializedResources resources, bool inspectOnly,
        long outputLimit)
    {
        var width = input.Width;
        var height = input.Height;
        if (width is < 1 or > 2048 || height is < 1 or > 2048 || input.Dimension != 2 || input.Count != 1)
            throw new BundleException("unity-bundle-texture-shape");

        // Serialized values are assigned by UnityEngine.TextureFormat.
        var encoding = input.Format switch
        {
            4 => "rgba32",
            10 => "dxt1",
            12 => "dxt5",
            _ => throw new BundleException("unity-bundle-texture-format"),
        };
        var pixelBytes = width * height * 4;
        if (!inspectOnly && pixelBytes > outputLimit)
            throw new BundleException("unity-bundle-output-limit");
        var compressed = encoding != "rgba32";
        var hasAlphaBlock = encoding == "dxt5";
        var length = compressed ? BlockCompression.Size(width, height, hasAlphaBlock) : pixelBytes;
        var inline = input.Pixels;
        var storage = "inline";
        byte[] bytes = [];
        if (inline.IsEmpty && input.External is { Size: > 0 } source)
        {
            storage = resources.TextureStorage;
            bytes = resources.ReadTexture(member, source, length, inspectOnly);
        }
        else
        {
            if (inline.Length < length) throw new BundleException("unity-bundle-texture-size");
            if (!inspectOnly) bytes = inline[..length].ToArray();
        }
        if (!inspectOnly && compressed) bytes = BlockCompression.Decode(bytes, width, height, hasAlphaBlock);
        var name = input.Name;
        return new Product(name.Length > 160 ? name[..160] : name, "rgba", bytes, Width: width, Height: height,
            TextureEncoding: encoding, TextureStorage: storage);
    }
}
