using System.Globalization;
using AssetsTools.NET;
using AssetViewer.UnityBundle.Objects.Textures;
using AssetViewer.UnityBundle.Objects.Resources;

namespace AssetViewer.UnityBundle.Objects.Sprites;

internal sealed class SpriteReader(string member, SerializedResources resources, bool inspectOnly,
    Func<long, AssetTypeValueField> readTexture, SpriteAtlasReader atlases)
{
    private long cachedPathId;
    private Product? cachedTexture;

    public Product Read(AssetTypeValueField field, long outputLimit)
    {
        var atlas = field["m_SpriteAtlas"];
        var atlasPathId = HasReference(atlas) ? LocalPathId(atlas, SpriteAtlasReader.ReferenceIssue) : 0;
        var render = atlasPathId == 0 ? field["m_RD"] : atlases.Resolve(field, atlasPathId);
        var frame = SpriteFrame.Read(field, render, atlasPathId != 0);
        var alpha = render["alphaTexture"];
        if (HasReference(alpha))
            throw new BundleException("unity-bundle-sprite-alpha");
        var pathId = LocalPathId(render["texture"], "unity-bundle-sprite-texture-reference");
        if (!inspectOnly && frame.Width * frame.Height * 4 > outputLimit)
            throw new BundleException("unity-bundle-output-limit");

        if (cachedTexture == null || pathId != cachedPathId)
        {
            var source = readTexture(pathId);
            frame.CheckBounds(source["m_Width"].AsInt, source["m_Height"].AsInt);
            cachedTexture = Texture2D.Read(source, member, resources, inspectOnly, 2048L * 2048 * 4);
            cachedPathId = pathId;
        }
        var sourceWidth = cachedTexture.Width!.Value;
        frame.CheckBounds(sourceWidth, cachedTexture.Height!.Value);
        byte[] bytes = inspectOnly ? [] : frame.Extract(cachedTexture.Bytes, sourceWidth);
        var packed = atlasPathId == 0 ? null : new PackedSprite(atlasPathId.ToString(CultureInfo.InvariantCulture),
            frame.CropWidth, frame.CropHeight, frame.OffsetX, frame.OffsetY, frame.Rotation);
        var name = field["m_Name"].AsString;
        return new Product(name.Length > 160 ? name[..160] : name, "rgba", bytes, Width: frame.Width, Height: frame.Height,
            TextureEncoding: cachedTexture.TextureEncoding, TextureStorage: cachedTexture.TextureStorage,
            Sprite: new SpriteSource(pathId.ToString(CultureInfo.InvariantCulture), frame.X, frame.Y, packed));
    }

    private static long LocalPathId(AssetTypeValueField reference, string issue)
    {
        var fileId = reference["m_FileID"];
        var pathId = reference["m_PathID"];
        if (fileId.IsDummy || pathId.IsDummy || fileId.AsInt != 0 || pathId.AsLong == 0)
            throw new BundleException(issue);
        return pathId.AsLong;
    }

    private static bool HasReference(AssetTypeValueField field) =>
        !field.IsDummy && (field["m_FileID"].AsInt != 0 || field["m_PathID"].AsLong != 0);
}
