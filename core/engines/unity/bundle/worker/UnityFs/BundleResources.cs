using AssetsTools.NET;

namespace AssetViewer.UnityBundle.UnityFs;

internal sealed class BundleResources(AssetBundleFile bundle)
{
    public byte[] ReadTexture(string owner, string path, ulong offset, uint size, int length, bool inspectOnly)
    {
        // Unity embeds the companion member alongside its serialized owner. Never resolve a disk path.
        var member = owner + ".resS";
        if (path != $"archive:/{owner}/{member}")
            throw new BundleException("unity-bundle-texture-stream-path");
        var index = bundle.GetFileIndex(member);
        if (index < 0 || bundle.BlockAndDirInfo.DirectoryInfos[index].IsSerialized)
            throw new BundleException("unity-bundle-texture-stream-missing");
        bundle.GetFileRange(index, out var start, out var available);
        if (size < length || offset > (ulong)available || size > (ulong)available - offset)
            throw new BundleException("unity-bundle-texture-stream-range");
        if (inspectOnly) return [];
        var data = new byte[length];
        bundle.DataReader.BaseStream.Position = start + (long)offset;
        bundle.DataReader.BaseStream.ReadExactly(data);
        return data;
    }
}
