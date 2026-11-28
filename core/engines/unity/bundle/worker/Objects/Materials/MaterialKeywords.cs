using AssetsTools.NET;

namespace AssetViewer.UnityBundle.Objects.Materials;

internal static class MaterialKeywords
{
    private static readonly HashSet<string> StandardKeywords =
    [
        "_METALLICGLOSSMAP", "_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A", "_NORMALMAP", "_EMISSION",
        "_PARALLAXMAP", "_DETAIL_MULX2", "_DETAIL_MUL", "_DETAIL_ADD", "_DETAIL_LERP",
        "_SPECULARHIGHLIGHTS_OFF", "_GLOSSYREFLECTIONS_OFF", "_ALPHATEST_ON", "_ALPHABLEND_ON",
        "_ALPHAPREMULTIPLY_ON",
    ];

    public static string[]? Read(AssetTypeValueField material)
    {
        var current = material["m_ValidKeywords.Array"];
        if (!current.IsDummy)
        {
            if (current.Children.Count > 256) throw new BundleException("unity-bundle-material-layout");
            return Select(current.Children.Select(keyword => keyword.AsString));
        }
        var legacy = material["m_ShaderKeywords"];
        if (legacy.IsDummy) return null;
        var keywords = legacy.AsString;
        if (keywords.Length > 4096) throw new BundleException("unity-bundle-material-layout");
        return Select(keywords.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }

    private static string[] Select(IEnumerable<string> keywords) =>
        keywords.Where(StandardKeywords.Contains).Distinct().Order(StringComparer.Ordinal).ToArray();
}
