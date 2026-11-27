using AssetsTools.NET;
using AssetViewer.UnityBundle.Formats;
using AssetViewer.UnityBundle.Objects.Resources;

namespace AssetViewer.UnityBundle.Objects.Textures;

internal static class Texture2D
{
    public static Product Read(AssetTypeValueField field, string member, SerializedResources resources, bool inspectOnly,
        long outputLimit)
    {
        var width = field["m_Width"].AsInt;
        var height = field["m_Height"].AsInt;
        if (width is < 1 or > 2048 || height is < 1 or > 2048 ||
            field["m_TextureDimension"].AsInt != 2 || field["m_ImageCount"].AsInt != 1)
            throw new BundleException("unity-bundle-texture-shape");

        // Serialized values are assigned by UnityEngine.TextureFormat.
        var encoding = field["m_TextureFormat"].AsInt switch
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
        var inline = field["image data"].AsByteArray;
        var stream = field["m_StreamData"];
        var storage = "inline";
        byte[] bytes = [];
        if (inline.Length == 0 && !stream.IsDummy && stream["size"].AsUInt != 0)
        {
            storage = "bundle-member";
            bytes = resources.ReadTexture(member, stream["path"].AsString,
                stream["offset"].AsULong, stream["size"].AsUInt, length, inspectOnly);
        }
        else
        {
            if (inline.Length < length) throw new BundleException("unity-bundle-texture-size");
            if (!inspectOnly) bytes = inline.Length == length ? inline : inline[..length];
        }
        if (!inspectOnly && compressed) bytes = BlockCompression.Decode(bytes, width, height, hasAlphaBlock);
        var name = field["m_Name"].AsString;
        return new Product(name.Length > 160 ? name[..160] : name, "rgba", bytes, Width: width, Height: height,
            TextureEncoding: encoding, TextureStorage: storage);
    }
}
