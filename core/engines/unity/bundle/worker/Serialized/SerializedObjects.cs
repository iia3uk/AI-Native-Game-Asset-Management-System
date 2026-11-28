using System.Globalization;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetViewer.UnityBundle.Objects.Audio;
using AssetViewer.UnityBundle.Objects.Mesh;
using AssetViewer.UnityBundle.Objects.Resources;
using AssetViewer.UnityBundle.Objects.Sprites;
using AssetViewer.UnityBundle.Objects.Textures;
using AssetViewer.UnityBundle.Serialized.Player;

namespace AssetViewer.UnityBundle.Serialized;

internal static class SerializedObjects
{
    public static void Read(AssetsManager manager, AssetsFileInstance member, string name, long length,
        SerializedResources resources, bool inspectOnly, List<Asset> entries, ref long outputLimit,
        bool allowPlayerLayout = false)
    {
        var file = member.file;
        if (file.AssetInfos.Count > 10000 - entries.Count) throw new BundleException("unity-bundle-object-limit");
        var objects = new Dictionary<long, AssetFileInfo>();
        foreach (var info in file.AssetInfos)
        {
            var offset = info.GetAbsoluteByteOffset(file);
            if (!objects.TryAdd(info.PathId, info) || offset < file.Header.DataOffset || offset > length ||
                info.ByteSize > length - offset)
                throw new BundleException("unity-bundle-object-range");
        }
        var atlases = new SpriteAtlasReader(pathId => ReadLocal(pathId, SpriteAtlasReader.ClassId, SpriteAtlasReader.ReferenceIssue));
        var sprites = new SpriteReader(name, resources, inspectOnly,
            pathId => ReadLocal(pathId, 28, "unity-bundle-sprite-texture-reference"), atlases);
        foreach (var info in file.AssetInfos)
        {
            var classId = info.GetTypeId(file);
            var row = new Asset(name, info.PathId.ToString(CultureInfo.InvariantCulture),
                classId, null, "unsupported", "unity-bundle-class-unsupported");
            entries.Add(ReadObject(manager, member, info, row, resources, sprites, inspectOnly,
                entries.Count, ref outputLimit, allowPlayerLayout));
        }

        AssetTypeValueField ReadLocal(long pathId, int classId, string issue)
        {
            if (!objects.TryGetValue(pathId, out var info) || info.GetTypeId(file) != classId || info.ByteSize > 32L << 20)
                throw new BundleException(issue);
            return manager.GetBaseField(member, info);
        }
    }

    private static Asset ReadObject(AssetsManager manager, AssetsFileInstance member, AssetFileInfo info,
        Asset row, SerializedResources resources, SpriteReader sprites, bool inspectOnly, int output,
        ref long outputLimit, bool allowPlayerLayout)
    {
        if (row.ClassId == SpriteAtlasReader.ClassId)
            return row with { Issue = "unity-bundle-sprite-atlas-container" };
        if (row.ClassId is not (28 or 43 or 83 or 213)) return row;
        var embedded = member.file.Metadata.TypeTreeEnabled;
        if (!embedded && (!allowPlayerLayout || !PlayerLayout.Matches(member.file, info, row.ClassId)))
            return row with { Issue = "unity-bundle-type-tree" };
        if (info.ByteSize > 32L << 20) return row with { Issue = "unity-bundle-object-size" };
        Product product;
        try
        {
            if (embedded)
            {
                var field = manager.GetBaseField(member, info);
                var name = field["m_Name"].AsString;
                row = row with { Name = name.Length > 160 ? name[..160] : name };
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
                var reader = PlayerLayout.Open(member.file, info);
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
            TextureColorSpace = product.TextureColorSpace,
            Vertices = product.Vertices, Triangles = product.Triangles, Audio = product.Audio, Status = "available", Issue = null };
        if (inspectOnly) return available;
        if (product.Bytes.Length > outputLimit) return row with { Issue = "unity-bundle-output-limit" };
        using var target = new FileStream(Path.Combine("output", $"{output}.{product.Format}"), FileMode.CreateNew);
        target.Write(product.Bytes);
        outputLimit -= product.Bytes.Length;
        return available with { Status = "decoded", Output = output, Bytes = product.Bytes.Length };
    }
}
