using AssetsTools.NET.Extra;
using AssetViewer.UnityBundle.Serialized;

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
            var materialBudget = 8192;
            var files = bundle.file.BlockAndDirInfo.DirectoryInfos;
            for (var index = 0; index < files.Count; index++)
            {
                var directory = files[index];
                if (!directory.IsSerialized) continue;
                if (directory.DecompressedSize > 64L << 20) throw new BundleException("unity-bundle-serialized-size");
                // Treat only this entry as serialized input. Dependency loading can search the filesystem.
                var member = manager.LoadAssetsFileFromBundle(bundle, index, false);
                if (member == null) throw new BundleException("unity-bundle-serialized-file");
                SerializedObjects.Read(manager, member, directory.Name, directory.DecompressedSize, resources,
                    inspectOnly, entries, ref outputLimit, ref materialBudget);
            }
            return new Report(1, Program.DecoderRevision, "completed", header.Format, header.Version, entries);
        }
        finally
        {
            manager.UnloadAll();
        }
    }
}
