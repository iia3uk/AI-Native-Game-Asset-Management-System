using AssetsTools.NET;
using AssetsTools.NET.Extra;

namespace AssetViewer.UnityBundle.Serialized;

internal sealed class SerializedMember(AssetsManager manager, AssetsFileInstance instance, string name, long length, int archive = 0)
{
    private Dictionary<long, AssetFileInfo>? table;
    public string Name { get; } = name;
    public AssetsFile File => instance.file;
    public int Archive { get; } = archive;

    public Dictionary<long, AssetFileInfo> ReadTable(int limit)
    {
        if (File.AssetInfos.Count > limit) throw new BundleException("unity-bundle-object-limit");
        if (table != null) return table;
        var objects = new Dictionary<long, AssetFileInfo>();
        foreach (var info in File.AssetInfos)
        {
            var offset = info.GetAbsoluteByteOffset(File);
            if (!objects.TryAdd(info.PathId, info) || offset < File.Header.DataOffset || offset > length ||
                info.ByteSize > length - offset)
                throw new BundleException("unity-bundle-object-range");
        }
        return table = objects;
    }

    public AssetTypeValueField ReadField(AssetFileInfo info) => manager.GetBaseField(instance, info);
}
