using AssetsTools.NET;
using System.Text.Json.Serialization;

namespace AssetViewer.UnityBundle.Objects.Materials;

internal sealed record TextureBinding(string Property, ObjectReference Texture, float[] Scale, float[] Offset);
internal sealed record TextureTransform(float[] Scale, float[] Offset);
internal sealed record MaterialSource(ObjectReference? Shader, string? Profile, TextureBinding[] Textures,
    Dictionary<string, float> Numbers, float[]? Color,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? Keywords,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] float[]? EmissionColor,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] TextureTransform? MainTransform);

internal sealed class MaterialReader(Func<AssetTypeValueField, ObjectReference?> readReference,
    Func<ObjectReference, bool> isStandard)
{
    public MaterialSource Read(AssetTypeValueField field, ref int budget)
    {
        var saved = field["m_SavedProperties"];
        var maps = saved["m_TexEnvs.Array"];
        if (maps.IsDummy || maps.Children.Count > 64)
            throw new BundleException("unity-bundle-material-layout");
        var textures = new Dictionary<string, TextureBinding>();
        TextureTransform? mainTransform = null;
        foreach (var pair in maps.Children)
        {
            var slot = pair["second"];
            var reference = readReference(slot["m_Texture"]);
            var property = pair["first"].AsString;
            if (reference == null && property != "_MainTex") continue;
            var scale = Vector(slot["m_Scale"], "x", "y");
            var offset = Vector(slot["m_Offset"], "x", "y");
            if (property == "_MainTex")
            {
                if (mainTransform != null) throw new BundleException("unity-bundle-material-layout");
                mainTransform = new TextureTransform(scale, offset);
            }
            if (reference == null) continue;
            if (property.Length is < 1 or > 80 || property.Any(char.IsControl) ||
                !textures.TryAdd(property, new TextureBinding(property, reference, scale, offset)))
                throw new BundleException("unity-bundle-material-layout");
        }
        var numbers = new Dictionary<string, float>();
        foreach (var array in new[] { "m_Floats.Array", "m_Ints.Array" })
        {
            var properties = saved[array];
            if (properties.Children.Count > 1024) throw new BundleException("unity-bundle-material-layout");
            foreach (var pair in properties.Children)
            {
                var name = pair["first"].AsString;
                if (name is not ("_Mode" or "_Cutoff" or "_Metallic" or "_Glossiness" or "_GlossMapScale" or
                    "_OcclusionStrength" or "_BumpScale" or "_SmoothnessTextureChannel")) continue;
                var value = array == "m_Ints.Array" ? pair["second"].AsInt : pair["second"].AsFloat;
                if (!float.IsFinite(value) || !numbers.TryAdd(name, value))
                    throw new BundleException("unity-bundle-material-layout");
            }
        }
        float[]? color = null;
        float[]? emission = null;
        var colors = saved["m_Colors.Array"];
        if (colors.Children.Count > 1024) throw new BundleException("unity-bundle-material-layout");
        foreach (var pair in colors.Children)
        {
            switch (pair["first"].AsString)
            {
                case "_Color" when color == null:
                    color = Vector(pair["second"], "r", "g", "b", "a");
                    break;
                case "_EmissionColor" when emission == null:
                    emission = Vector(pair["second"], "r", "g", "b", "a");
                    break;
                case "_Color" or "_EmissionColor":
                    throw new BundleException("unity-bundle-material-layout");
            }
        }
        if (textures.Count + 1 > budget) throw new BundleException("unity-bundle-material-limit");
        budget -= textures.Count + 1;
        var shader = readReference(field["m_Shader"]);
        var standard = shader != null && isStandard(shader);
        return new MaterialSource(shader, standard ? "standard" : null, textures.Values.ToArray(), numbers, color,
            MaterialKeywords.Read(field), emission, mainTransform);
    }

    private static float[] Vector(AssetTypeValueField field, params string[] axes) => axes.Select(axis =>
    {
        var component = field[axis];
        if (component.IsDummy || !float.IsFinite(component.AsFloat))
            throw new BundleException("unity-bundle-material-layout");
        return component.AsFloat;
    }).ToArray();
}
