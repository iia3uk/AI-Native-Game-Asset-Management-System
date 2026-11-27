namespace AssetViewer.UnityBundle.Objects.Resources;

internal abstract class SerializedResources
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

    protected abstract ResourceSlice Resolve(string owner, string path, ulong offset, ulong size,
        string suffix, string issue);
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
