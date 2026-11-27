using System.Globalization;
using AssetsTools.NET;
using AssetViewer.UnityBundle.Objects.Textures;
using AssetViewer.UnityBundle.Objects.Resources;

namespace AssetViewer.UnityBundle.Objects.Sprites;

internal sealed class SpriteReader(string member, SerializedResources resources, bool inspectOnly,
    Func<long, AssetTypeValueField> readTexture)
{
    private long cachedPathId;
    private Product? cachedTexture;

    public Product Read(AssetTypeValueField field, long outputLimit)
    {
        var render = field["m_RD"];
        var atlas = field["m_SpriteAtlas"];
        if (!atlas.IsDummy && HasReference(atlas))
            throw new BundleException("unity-bundle-sprite-atlas");
        var settings = render["settingsRaw"];
        // Native Unity 6.3 and 6.6 use these values for unpacked FullRect and Tight sprites.
        if (settings.IsDummy || settings.AsUInt is not (0 or 0x40 or 0xc00 or 0xc40))
            throw new BundleException("unity-bundle-sprite-packing");
        var alpha = render["alphaTexture"];
        if (!alpha.IsDummy && HasReference(alpha))
            throw new BundleException("unity-bundle-sprite-alpha");
        var texture = render["texture"];
        if (texture.IsDummy || texture["m_FileID"].AsInt != 0 || texture["m_PathID"].AsLong == 0)
            throw new BundleException("unity-bundle-sprite-texture-reference");
        var pathId = texture["m_PathID"].AsLong;

        var rect = render["textureRect"];
        var x = Coordinate(rect["x"]);
        var y = Coordinate(rect["y"]);
        var width = Coordinate(rect["width"]);
        var height = Coordinate(rect["height"]);
        if (width == 0 || height == 0)
            throw new BundleException("unity-bundle-sprite-rect");
        if (!inspectOnly && width * height * 4 > outputLimit)
            throw new BundleException("unity-bundle-output-limit");

        if (cachedTexture == null || pathId != cachedPathId)
        {
            var source = readTexture(pathId);
            CheckBounds(source["m_Width"].AsInt, source["m_Height"].AsInt);
            cachedTexture = Texture2D.Read(source, member, resources, inspectOnly, 2048L * 2048 * 4);
            cachedPathId = pathId;
        }
        var sourceWidth = cachedTexture.Width!.Value;
        CheckBounds(sourceWidth, cachedTexture.Height!.Value);
        byte[] bytes = [];
        if (!inspectOnly)
        {
            var stride = width * 4;
            bytes = new byte[stride * height];
            for (int row = 0; row < height; row++)
                cachedTexture.Bytes.AsSpan(((y + row) * sourceWidth + x) * 4, stride).CopyTo(bytes.AsSpan(row * stride));
        }
        var name = field["m_Name"].AsString;
        return new Product(name.Length > 160 ? name[..160] : name, "rgba", bytes, Width: width, Height: height,
            TextureEncoding: cachedTexture.TextureEncoding, TextureStorage: cachedTexture.TextureStorage,
            Sprite: new SpriteSource(pathId.ToString(CultureInfo.InvariantCulture), x, y));

        void CheckBounds(int textureWidth, int textureHeight)
        {
            if (x + width > textureWidth || y + height > textureHeight)
                throw new BundleException("unity-bundle-sprite-rect");
        }
    }

    private static int Coordinate(AssetTypeValueField field)
    {
        if (field.IsDummy) throw new BundleException("unity-bundle-sprite-rect");
        var value = field.AsFloat;
        if (!float.IsFinite(value) || value < 0 || value > 2048 || value != MathF.Truncate(value))
            throw new BundleException("unity-bundle-sprite-rect");
        return (int)value;
    }

    private static bool HasReference(AssetTypeValueField field) =>
        field["m_FileID"].AsInt != 0 || field["m_PathID"].AsLong != 0;
}
