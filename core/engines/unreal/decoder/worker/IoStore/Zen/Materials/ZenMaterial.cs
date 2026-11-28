using AssetViewer.UnrealDecode.Objects;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Readers;

namespace AssetViewer.UnrealDecode.IoStore.Zen.Materials;

internal sealed record ZenMaterialExport(string Type, ZenReference? Parent, ZenParameter[] Textures,
    ZenParameter[] Scalars, ZenParameter[] Vectors, ZenStreamingTexture[] Streaming);
internal sealed record ZenParameter(string Name, string? Association, int? Index, object? Value,
    ZenReference? Reference, string? Status);
internal sealed record ZenStreamingTexture(ZenSoftReference? Reference, string? TextureName, int? UvChannel, float? SamplingScale);

internal static class ZenMaterial
{
    public static ZenMaterialExport Read(byte[] bytes, ZenPackage package, ZenExportKind kind)
    {
        using var source = new FByteArchive("ZenMaterial", bytes, package.Version);
        using var archive = new FAssetArchive(source, package);
        ZenReference? parent = null;
        ZenParameter[] textures = [], scalars = [], vectors = [];
        ZenStreamingTexture[] streaming = [];
        var seen = new HashSet<string>();
        TaggedProperties.Read(archive, tag =>
        {
            var name = tag.Name.Text;
            if (name is not ("Parent" or "TextureParameterValues" or "ScalarParameterValues" or
                "VectorParameterValues" or "TextureStreamingData")) return;
            Require(seen.Add(name));
            switch (name)
            {
                case "Parent":
                    Require(kind == ZenExportKind.MaterialInstance && Matches(tag, "ObjectProperty", 4));
                    parent = package.Reference(archive.Read<int>());
                    break;
                case "TextureParameterValues":
                    textures = TaggedProperties.StructArray(archive, tag, "TextureParameterValue",
                        end => ReadParameter(archive, end, package, "Texture"));
                    break;
                case "ScalarParameterValues":
                    scalars = TaggedProperties.StructArray(archive, tag, "ScalarParameterValue",
                        end => ReadParameter(archive, end, package, "Scalar"));
                    break;
                case "VectorParameterValues":
                    vectors = TaggedProperties.StructArray(archive, tag, "VectorParameterValue",
                        end => ReadParameter(archive, end, package, "Vector"));
                    break;
                case "TextureStreamingData":
                    streaming = TaggedProperties.StructArray(archive, tag, "MaterialTextureInfo",
                        end => ReadStreaming(archive, end));
                    break;
            }
        });
        return new(kind == ZenExportKind.Material ? "Material" : "MaterialInstanceConstant", parent,
            textures, scalars, vectors, streaming);
    }

    private static ZenParameter ReadParameter(FAssetArchive archive, long end, ZenPackage package, string kind)
    {
        (string Name, string? Association, int? Index)? info = null;
        ZenReference? reference = null;
        string? status = null;
        object? value = null;
        var hasValue = false;
        TaggedProperties.ReadTags(archive, end, tag =>
        {
            if (tag.Name.Text == "ParameterInfo")
            {
                Require(info == null && tag.PropertyType.Text == "StructProperty" &&
                    tag.TagData?.StructType == "MaterialParameterInfo" && tag.ArrayIndex == 0);
                info = ParameterInfo(archive, archive.Position + tag.Size);
            }
            else if (tag.Name.Text == "ParameterValue")
            {
                Require(!hasValue);
                hasValue = true;
                if (kind == "Texture")
                {
                    Require(Matches(tag, "ObjectProperty", 4));
                    var index = archive.Read<int>();
                    reference = package.Reference(index);
                    status = reference != null ? "reference" : index == 0 ? "empty" : "unsupported-reference";
                }
                else if (kind == "Scalar")
                {
                    Require(Matches(tag, "FloatProperty", 4));
                    value = FiniteFloat(archive);
                }
                else
                {
                    Require(Matches(tag, "StructProperty", 16) && tag.TagData?.StructType == "LinearColor");
                    value = new[] { FiniteFloat(archive), FiniteFloat(archive), FiniteFloat(archive), FiniteFloat(archive) };
                }
            }
        });
        var scope = info ?? throw ZenPackage.Invalid();
        return new(scope.Name, scope.Association, scope.Index, value, reference, status);
    }

    private static (string Name, string? Association, int? Index) ParameterInfo(FAssetArchive archive, long end)
    {
        string? name = null, association = null;
        int? index = null;
        TaggedProperties.ReadTags(archive, end, tag =>
        {
            switch (tag.Name.Text)
            {
                case "Name":
                    Require(name == null && Matches(tag, "NameProperty", 8));
                    name = ReadName(archive);
                    break;
                case "Association":
                    Require(association == null && tag.ArrayIndex == 0 && tag.Size == 8 &&
                        tag.PropertyType.Text is "EnumProperty" or "ByteProperty" &&
                        tag.TagData?.EnumName == "EMaterialParameterAssociation");
                    association = ReadName(archive);
                    break;
                case "Index":
                    Require(index == null && Matches(tag, "IntProperty", 4));
                    index = archive.Read<int>();
                    break;
            }
        });
        Require(archive.Position == end);
        association ??= index == -1 ? "GlobalParameter" : null;
        return (name ?? throw ZenPackage.Invalid(), association, index ?? (association == "GlobalParameter" ? -1 : null));
    }

    private static ZenStreamingTexture ReadStreaming(FAssetArchive archive, long end)
    {
        ZenSoftReference? reference = null;
        string? name = null;
        int? uv = null;
        float? scale = null;
        var seen = new HashSet<string>();
        TaggedProperties.ReadTags(archive, end, tag =>
        {
            var field = tag.Name.Text;
            if (field is not ("TextureReference" or "TextureName" or "UVChannelIndex" or "SamplingScale")) return;
            Require(seen.Add(field));
            switch (field)
            {
                case "TextureReference":
                    // Top-level asset path, with no subobject path.
                    if (tag.ArrayIndex == 0 && tag.Size == 20 && (tag.PropertyType.Text == "SoftObjectProperty" ||
                        tag.PropertyType.Text == "StructProperty" && tag.TagData?.StructType == "SoftObjectPath"))
                    {
                        var package = archive.ReadFName().Text;
                        var asset = archive.ReadFName().Text;
                        if (archive.Read<int>() == 0 && ZenImports.ValidPackage(package) &&
                            asset != "None" && ZenImports.ValidObject(asset)) reference = new(package, asset);
                    }
                    break;
                case "TextureName":
                    Require(Matches(tag, "NameProperty", 8));
                    name = ReadName(archive);
                    break;
                case "UVChannelIndex":
                    Require(Matches(tag, "IntProperty", 4));
                    uv = archive.Read<int>();
                    break;
                case "SamplingScale":
                    Require(Matches(tag, "FloatProperty", 4));
                    scale = FiniteFloat(archive);
                    break;
            }
        });
        return new(reference, name, uv, scale);
    }

    private static string ReadName(FAssetArchive archive)
    {
        var name = archive.ReadFName().Text;
        Require(name.Length is > 0 and <= 256 && name != "None" && name.All(ch => !char.IsControl(ch)));
        return name;
    }

    private static float FiniteFloat(FAssetArchive archive)
    {
        var value = archive.Read<float>();
        return float.IsFinite(value) ? value : throw ZenPackage.Invalid();
    }

    private static bool Matches(FPropertyTag tag, string type, int size) =>
        tag.PropertyType.Text == type && tag.ArrayIndex == 0 && tag.Size == size;

    private static void Require(bool valid)
    {
        if (!valid) throw ZenPackage.Invalid();
    }
}
