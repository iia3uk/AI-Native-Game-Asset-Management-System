using AssetsTools.NET;

namespace AssetViewer.UnityBundle.Objects.Materials;

internal sealed record TextureBinding(string Property, ObjectReference Texture, float[] Scale, float[] Offset);
internal sealed record MaterialSource(ObjectReference? Shader, string? Profile, TextureBinding[] Textures,
    Dictionary<string, float> Numbers, float[]? Color);

internal sealed class MaterialReader(Func<string, bool> isLocalStandard, Func<int, bool> isBuiltinShaderFile)
{
    public MaterialSource Read(AssetTypeValueField field, ref int budget)
    {
        var saved = field["m_SavedProperties"];
        var maps = saved["m_TexEnvs.Array"];
        if (maps.IsDummy || maps.Children.Count > 64)
            throw new BundleException("unity-bundle-material-layout");
        var textures = new Dictionary<string, TextureBinding>();
        foreach (var pair in maps.Children)
        {
            var slot = pair["second"];
            var reference = ObjectReference.Read(slot["m_Texture"]);
            if (reference == null) continue;
            var property = pair["first"].AsString;
            if (property.Length is < 1 or > 80 || property.Any(char.IsControl) ||
                !textures.TryAdd(property, new TextureBinding(property, reference,
                    Vector(slot["m_Scale"], "x", "y"), Vector(slot["m_Offset"], "x", "y"))))
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
                if (name is not ("_Mode" or "_Cutoff" or "_Metallic" or "_Glossiness")) continue;
                var value = array == "m_Ints.Array" ? pair["second"].AsInt : pair["second"].AsFloat;
                if (!float.IsFinite(value) || !numbers.TryAdd(name, value))
                    throw new BundleException("unity-bundle-material-layout");
            }
        }
        float[]? color = null;
        var colors = saved["m_Colors.Array"];
        if (colors.Children.Count > 1024) throw new BundleException("unity-bundle-material-layout");
        foreach (var pair in colors.Children.Where(pair => pair["first"].AsString == "_Color"))
        {
            if (color != null) throw new BundleException("unity-bundle-material-layout");
            color = Vector(pair["second"], "r", "g", "b", "a");
        }
        if (textures.Count + 1 > budget) throw new BundleException("unity-bundle-material-limit");
        budget -= textures.Count + 1;
        var shader = ObjectReference.Read(field["m_Shader"]);
        var standard = shader != null && (shader.FileId == 0
            ? isLocalStandard(shader.PathId) : shader.PathId == "46" && isBuiltinShaderFile(shader.FileId));
        return new MaterialSource(shader, standard ? "standard" : null, textures.Values.ToArray(), numbers, color);
    }

    private static float[] Vector(AssetTypeValueField field, params string[] axes) => axes.Select(axis =>
    {
        var component = field[axis];
        if (component.IsDummy || !float.IsFinite(component.AsFloat))
            throw new BundleException("unity-bundle-material-layout");
        return component.AsFloat;
    }).ToArray();
}
