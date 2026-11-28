using AssetsTools.NET;

namespace AssetViewer.UnityBundle.Objects.Sprites;

internal sealed class SpriteAtlasReader(Func<long, AssetTypeValueField> readAtlas)
{
    public const int ClassId = 687078895;
    public const string ReferenceIssue = "unity-bundle-sprite-atlas";
    private const string KeyIssue = "unity-bundle-sprite-atlas-key";

    private long cachedPathId;
    private Dictionary<RenderKey, AssetTypeValueField>? cachedEntries;

    public AssetTypeValueField Resolve(AssetTypeValueField sprite, long pathId)
    {
        if (cachedEntries == null || cachedPathId != pathId)
        {
            var atlas = readAtlas(pathId);
            var variant = atlas["m_IsVariant"];
            if (variant.IsDummy || variant.AsBool)
                throw new BundleException("unity-bundle-sprite-atlas-variant");
            var map = atlas["m_RenderDataMap"]["Array"];
            if (map.IsDummy || map.Children.Count > 10000)
                throw new BundleException(KeyIssue);
            var entries = new Dictionary<RenderKey, AssetTypeValueField>();
            foreach (var pair in map.Children)
            {
                var render = pair["second"];
                if (render.IsDummy || !entries.TryAdd(Key(pair["first"]), render))
                    throw new BundleException(KeyIssue);
            }
            cachedEntries = entries;
            cachedPathId = pathId;
        }
        if (!cachedEntries.TryGetValue(Key(sprite["m_RenderDataKey"]), out var entry))
            throw new BundleException(KeyIssue);
        return entry;
    }

    private static RenderKey Key(AssetTypeValueField pair)
    {
        var guid = pair["first"];
        var a = guid["data[0]"];
        var b = guid["data[1]"];
        var c = guid["data[2]"];
        var d = guid["data[3]"];
        var id = pair["second"];
        if (a.IsDummy || b.IsDummy || c.IsDummy || d.IsDummy || id.IsDummy)
            throw new BundleException(KeyIssue);
        return new RenderKey(a.AsUInt, b.AsUInt, c.AsUInt, d.AsUInt, id.AsLong);
    }

    private readonly record struct RenderKey(uint A, uint B, uint C, uint D, long Id);
}
