using System.Globalization;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetViewer.UnityBundle.Objects.Mesh;
using AssetViewer.UnityBundle.Objects.Sprites;
using AssetViewer.UnityBundle.Objects.Textures;

namespace AssetViewer.UnityBundle.UnityFs;

internal static class BundleObjects
{
    public static Report Read(bool inspectOnly, long outputLimit)
    {
        using var input = File.OpenRead("input.bundle");
        var header = Header.Read(input);
        input.Position = 0;
        var manager = new AssetsManager();
        try
        {
            var bundle = manager.LoadBundleFile(input, "input.bundle", false);
            BundleDirectory.Validate(bundle.file);
            var resources = new BundleResources(bundle.file);
            var entries = new List<Asset>();
            var files = bundle.file.BlockAndDirInfo.DirectoryInfos;
            for (var index = 0; index < files.Count; index++)
            {
                var directory = files[index];
                if (!directory.IsSerialized) continue;
                if (directory.DecompressedSize > 64L << 20) throw new BundleException("unity-bundle-serialized-size");
                // Treat only this entry as serialized input. Dependency loading can search the filesystem.
                var member = manager.LoadAssetsFileFromBundle(bundle, index, false);
                if (member == null) throw new BundleException("unity-bundle-serialized-file");
                var file = member.file;
                if (file.AssetInfos.Count > 10000 - entries.Count) throw new BundleException("unity-bundle-object-limit");
                var objects = new Dictionary<long, AssetFileInfo>();
                foreach (var info in file.AssetInfos)
                {
                    var offset = info.GetAbsoluteByteOffset(file);
                    if (!objects.TryAdd(info.PathId, info) || offset < 0 || offset > directory.DecompressedSize ||
                        info.ByteSize > directory.DecompressedSize - offset)
                        throw new BundleException("unity-bundle-object-range");
                }
                var sprites = new SpriteReader(directory.Name, resources, inspectOnly, pathId =>
                {
                    if (!objects.TryGetValue(pathId, out var texture) || texture.GetTypeId(file) != 28 ||
                        texture.ByteSize > 32L << 20)
                        throw new BundleException("unity-bundle-sprite-texture-reference");
                    return manager.GetBaseField(member, texture);
                });
                foreach (var info in file.AssetInfos)
                {
                    var classId = info.GetTypeId(file);
                    var row = new Asset(directory.Name, info.PathId.ToString(CultureInfo.InvariantCulture),
                        classId, null, "unsupported", "unity-bundle-class-unsupported");
                    entries.Add(ReadObject(manager, member, info, row, resources, sprites, inspectOnly,
                        entries.Count, ref outputLimit));
                }
            }
            return new Report(1, Program.DecoderRevision, "completed", header.Format, header.Version, entries);
        }
        finally
        {
            manager.UnloadAll();
        }
    }

    private static Asset ReadObject(AssetsManager manager, AssetsFileInstance member, AssetFileInfo info,
        Asset row, BundleResources resources, SpriteReader sprites, bool inspectOnly, int output, ref long outputLimit)
    {
        if (row.ClassId is not (28 or 43 or 213)) return row;
        if (!member.file.Metadata.TypeTreeEnabled) return row with { Issue = "unity-bundle-type-tree" };
        if (info.ByteSize > 32L << 20) return row with { Issue = "unity-bundle-object-size" };
        Product product;
        try
        {
            var field = manager.GetBaseField(member, info);
            product = row.ClassId switch
            {
                28 => Texture2D.Read(field, row.Member, resources, inspectOnly, outputLimit),
                213 => sprites.Read(field, outputLimit),
                _ => StaticMesh.Read(field).ToProduct(inspectOnly),
            };
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
            Vertices = product.Vertices, Triangles = product.Triangles, Status = "available", Issue = null };
        if (inspectOnly) return available;
        if (product.Bytes.Length > outputLimit) return row with { Issue = "unity-bundle-output-limit" };
        using var target = new FileStream(Path.Combine("output", $"{output}.{product.Format}"), FileMode.CreateNew);
        target.Write(product.Bytes);
        outputLimit -= product.Bytes.Length;
        return available with { Status = "decoded", Output = output, Bytes = product.Bytes.Length };
    }
}
