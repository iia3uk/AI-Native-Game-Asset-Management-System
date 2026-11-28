using AssetsTools.NET.Extra;
using AssetViewer.UnityBundle.Serialized;

namespace AssetViewer.UnityBundle.UnityFs;

internal sealed class BundleArchive : IDisposable
{
    private readonly Stream input;
    private readonly AssetsManager manager = new();
    private readonly BundleFileInstance bundle;
    public Header Header { get; }
    public long InputBytes => input.Length;
    public long UnpackedBytes { get; }
    public int Index { get; }
    public BundleResources Resources { get; }
    public string[] Names { get; }

    public BundleArchive(int index, string staged, long inputLimit = Header.InputLimit)
    {
        Index = index;
        input = File.OpenRead(staged);
        try
        {
            if (input.Length > inputLimit) throw new BundleException("unity-bundle-input-size");
            Header = Header.Read(input);
            input.Position = 0;
            bundle = manager.LoadBundleFile(input, staged, false);
            UnpackedBytes = BundleDirectory.Validate(bundle.file);
            Resources = new BundleResources(bundle.file);
            Names = bundle.file.BlockAndDirInfo.DirectoryInfos.Where(entry => entry.IsSerialized).Select(entry => entry.Name).ToArray();
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public List<SerializedMember> ReadMembers(int limit)
    {
        var members = new List<SerializedMember>();
        var files = bundle.file.BlockAndDirInfo.DirectoryInfos;
        for (var index = 0; index < files.Count; index++)
        {
            var directory = files[index];
            if (!directory.IsSerialized) continue;
            if (directory.DecompressedSize > 64L << 20) throw new BundleException("unity-bundle-serialized-size");
            // Dependency loading in AssetsTools.NET can search the filesystem.
            var file = manager.LoadAssetsFileFromBundle(bundle, index, false);
            if (file == null) throw new BundleException("unity-bundle-serialized-file");
            var member = new SerializedMember(manager, file, directory.Name, directory.DecompressedSize, Index);
            limit -= member.ReadTable(limit).Count;
            members.Add(member);
        }
        return members;
    }

    public void Dispose()
    {
        try { manager.UnloadAll(); }
        finally { input.Dispose(); }
    }
}
