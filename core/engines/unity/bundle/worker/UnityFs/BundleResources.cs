using AssetsTools.NET;
using AssetViewer.UnityBundle.Objects.Resources;

namespace AssetViewer.UnityBundle.UnityFs;

internal sealed class BundleResources(AssetBundleFile bundle) : SerializedResources
{
    protected override ResourceSlice Resolve(string owner, string path, ulong offset, ulong size, string suffix, string issue)
    {
        // Unity embeds the companion member alongside its serialized owner. Never resolve a disk path.
        var member = owner + suffix;
        if (path != $"archive:/{owner}/{member}")
            throw new BundleException($"unity-bundle-{issue}-path");
        var index = bundle.GetFileIndex(member);
        if (index < 0 || bundle.BlockAndDirInfo.DirectoryInfos[index].IsSerialized)
            throw new BundleException($"unity-bundle-{issue}-missing");
        bundle.GetFileRange(index, out var start, out var available);
        if (offset > (ulong)available || size > (ulong)available - offset)
            throw new BundleException($"unity-bundle-{issue}-range");
        return new ResourceSlice(bundle.DataReader.BaseStream, start + (long)offset, (long)size);
    }
}
