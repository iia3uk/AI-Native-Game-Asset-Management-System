using System.Globalization;
using AssetsTools.NET;
using AssetViewer.UnityBundle.Objects.Audio;
using AssetViewer.UnityBundle.Objects.Materials;
using AssetViewer.UnityBundle.Objects.Mesh;
using AssetViewer.UnityBundle.Objects.Resources;
using AssetViewer.UnityBundle.Objects.Sprites;
using AssetViewer.UnityBundle.Objects.Textures;
using AssetViewer.UnityBundle.Serialized.Player;

namespace AssetViewer.UnityBundle.Serialized;

internal static class SerializedObjects
{
    public static void Read(SerializedMember member, ObjectTables tables, IReadOnlyDictionary<ObjectAddress, MeshBindings> bindings,
        SerializedResources resources, bool inspectOnly, List<Asset> entries,
        ref long outputLimit, ref int materialBudget, bool allowPlayerLayout = false)
    {
        var file = member.File;
        var objects = tables.In(member);
        var atlases = new SpriteAtlasReader(pathId => ReadLocal(pathId, SpriteAtlasReader.ClassId, SpriteAtlasReader.ReferenceIssue));
        var sprites = new SpriteReader(member.Name, resources, inspectOnly,
            pathId => ReadLocal(pathId, 28, "unity-bundle-sprite-texture-reference"), atlases);
        var materials = new MaterialReader(field => tables.ReadReference(member, field), reference => tables.IsStandard(member, reference));
        foreach (var info in file.AssetInfos)
        {
            var classId = info.GetTypeId(file);
            var row = new Asset(member.Name, info.PathId.ToString(CultureInfo.InvariantCulture),
                classId, null, "unsupported", "unity-bundle-class-unsupported", SourceArchive: member.Archive);
            if (bindings.TryGetValue(new ObjectAddress(member.Name, info.PathId), out var binding) && binding.Slots is { } slots)
            {
                if (slots.Length > materialBudget) binding = new MeshBindings("unresolved");
                else materialBudget -= slots.Length;
            }
            entries.Add(ReadObject(member, info, row, resources, sprites, materials, binding, inspectOnly,
                entries.Count, ref outputLimit, ref materialBudget, allowPlayerLayout));
        }

        AssetTypeValueField ReadLocal(long pathId, int classId, string issue)
        {
            if (!objects.TryGetValue(pathId, out var info) || info.GetTypeId(file) != classId || info.ByteSize > 32L << 20)
                throw new BundleException(issue);
            return member.ReadField(info);
        }
    }

    private static Asset ReadObject(SerializedMember member, AssetFileInfo info,
        Asset row, SerializedResources resources, SpriteReader sprites, MaterialReader materials, MeshBindings? binding,
        bool inspectOnly, int output, ref long outputLimit, ref int materialBudget, bool allowPlayerLayout)
    {
        if (row.ClassId == SpriteAtlasReader.ClassId)
            return row with { Issue = "unity-bundle-sprite-atlas-container" };
        if (row.ClassId is not (21 or 28 or 43 or 83 or 213)) return row;
        var embedded = member.File.Metadata.TypeTreeEnabled;
        if (!embedded && (!allowPlayerLayout || !PlayerLayout.Matches(member.File, info, row.ClassId)))
            return row with { Issue = "unity-bundle-type-tree" };
        if (info.ByteSize > 32L << 20) return row with { Issue = "unity-bundle-object-size" };
        Product product;
        try
        {
            if (embedded)
            {
                var field = member.ReadField(info);
                var name = field["m_Name"].AsString;
                row = row with { Name = name.Length > 160 ? name[..160] : name };
                if (row.ClassId == 21)
                    return row with { Status = inspectOnly ? "available" : "decoded", Format = "material", Issue = null,
                        Material = materials.Read(field, ref materialBudget) };
                product = row.ClassId switch
                {
                    28 => Texture2D.Read(field, row.Member, resources, inspectOnly, outputLimit),
                    83 => AudioClip.Read(field, row.Member, resources, inspectOnly, outputLimit),
                    213 => sprites.Read(field, outputLimit),
                    _ => StaticMesh.Read(field).ToProduct(inspectOnly),
                };
            }
            else
            {
                var reader = PlayerLayout.Open(member.File, info);
                var name = reader.String(16384);
                row = row with { Name = name.Length > 160 ? name[..160] : name };
                product = row.ClassId == 28
                    ? Texture2D.Read(PlayerLayout.ReadTexture(ref reader, name), row.Member, resources, inspectOnly, outputLimit)
                    : AudioClip.Read(PlayerLayout.ReadAudio(ref reader, name), row.Member, resources, inspectOnly, outputLimit);
            }
        }
        catch (BundleException error)
        {
            return row with { Issue = error.Message };
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            return row with { Issue = "unity-bundle-object-invalid" };
        }
        var available = row with { Name = product.Name, Format = product.Format, Width = product.Width, Height = product.Height,
            TextureEncoding = product.TextureEncoding, TextureStorage = product.TextureStorage, Sprite = product.Sprite,
            TextureColorSpace = product.TextureColorSpace, Sampler = product.Sampler,
            MeshMaterials = binding,
            Vertices = product.Vertices, Triangles = product.Triangles, Audio = product.Audio, Status = "available", Issue = null };
        if (inspectOnly) return available;
        if (product.Bytes.Length > outputLimit) return row with { Issue = "unity-bundle-output-limit" };
        using var target = new FileStream(Path.Combine("output", $"{output}.{product.Format}"), FileMode.CreateNew);
        target.Write(product.Bytes);
        outputLimit -= product.Bytes.Length;
        return available with { Status = "decoded", Output = output, Bytes = product.Bytes.Length };
    }
}
