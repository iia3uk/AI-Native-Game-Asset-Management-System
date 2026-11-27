using System.Globalization;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetViewer.UnityBundle.Objects;

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
                var seen = new HashSet<long>();
                foreach (var info in file.AssetInfos)
                {
                    var offset = info.GetAbsoluteByteOffset(file);
                    if (!seen.Add(info.PathId) || offset < 0 || offset > directory.DecompressedSize ||
                        info.ByteSize > directory.DecompressedSize - offset)
                        throw new BundleException("unity-bundle-object-range");
                    var classId = info.GetTypeId(file);
                    var row = new Asset(directory.Name, info.PathId.ToString(CultureInfo.InvariantCulture), classId, null,
                        "unsupported", classId == 28 ? "unity-bundle-texture-format" : "unity-bundle-class-unsupported");
                    if (classId == 28 && file.Metadata.TypeTreeEnabled && info.ByteSize <= 32L << 20)
                    {
                        try
                        {
                            var texture = Texture.Read(manager.GetBaseField(member, info));
                            if (texture != null)
                            {
                                row = row with { Name = texture.Name, Width = texture.Width, Height = texture.Height,
                                    Status = "available", Issue = null };
                                if (!inspectOnly)
                                {
                                    if (texture.Pixels.Length > outputLimit)
                                        row = row with { Status = "unsupported", Issue = "unity-bundle-output-limit" };
                                    else
                                    {
                                        var output = entries.Count;
                                        using var target = new FileStream(Path.Combine("output", $"{output}.rgba"), FileMode.CreateNew);
                                        target.Write(texture.Pixels);
                                        outputLimit -= texture.Pixels.Length;
                                        row = row with { Status = "decoded", Output = output };
                                    }
                                }
                            }
                        }
                        catch (Exception error) when (error is not (OutOfMemoryException or IOException))
                        {
                            row = row with { Status = "unsupported", Issue = "unity-bundle-texture-invalid" };
                        }
                    }
                    else if (classId == 28)
                    {
                        row = row with { Issue = file.Metadata.TypeTreeEnabled ? "unity-bundle-object-size" : "unity-bundle-type-tree" };
                    }
                    entries.Add(row);
                }
            }
            return new Report(1, "completed", header.Format, header.Version, entries);
        }
        finally
        {
            manager.UnloadAll();
        }
    }
}
