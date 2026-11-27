using AssetsTools.NET;

namespace AssetViewer.UnityBundle.Objects;

internal sealed record Texture(string Name, int Width, int Height, byte[] Pixels)
{
    public Product ToProduct() => new(Name, "rgba", Pixels, Width: Width, Height: Height);

    public static Texture? Read(AssetTypeValueField field)
    {
        var width = field["m_Width"].AsInt;
        var height = field["m_Height"].AsInt;
        if (width is < 1 or > 2048 || height is < 1 or > 2048 ||
            field["m_TextureFormat"].AsInt != 4 || field["m_TextureDimension"].AsInt != 2 ||
            field["m_ImageCount"].AsInt != 1) return null;
        var pixels = field["image data"].AsByteArray;
        var length = width * height * 4;
        if (pixels.Length < length) return null;
        var name = field["m_Name"].AsString;
        return new Texture(name.Length > 160 ? name[..160] : name, width, height, pixels[..length]);
    }
}
