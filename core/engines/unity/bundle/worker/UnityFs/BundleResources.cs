using AssetsTools.NET;

namespace AssetViewer.UnityBundle.UnityFs;

internal sealed class BundleResources(AssetBundleFile bundle)
{
    public byte[] ReadTexture(string owner, string path, ulong offset, uint size, int length, bool inspectOnly)
    {
        var resource = Resolve(owner, path, offset, size, ".resS", "texture-stream");
        if (size < length) throw new BundleException("unity-bundle-texture-stream-range");
        if (inspectOnly) return [];
        var data = new byte[length];
        resource.Read(0, data);
        return data;
    }

    public ResourceSlice ResolveAudio(string owner, string path, ulong offset, ulong size) =>
        Resolve(owner, path, offset, size, ".resource", "audio-stream");

    private ResourceSlice Resolve(string owner, string path, ulong offset, ulong size, string suffix, string issue)
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

internal readonly struct ResourceSlice(Stream stream, long start, long length)
{
    public long Length => length;

    public void Read(long offset, Span<byte> target)
    {
        if (offset < 0 || offset > length || target.Length > length - offset)
            throw new BundleException("unity-bundle-resource-range");
        stream.Position = start + offset;
        stream.ReadExactly(target);
    }
}
