namespace AssetViewer.UnityBundle.Objects.Resources;

internal readonly record struct ResourceReference(string Path, ulong Offset, ulong Size);

internal abstract class SerializedResources
{
    public virtual string TextureStorage => "bundle-member";

    public byte[] ReadTexture(string owner, ResourceReference source, int length, bool inspectOnly)
    {
        var resource = Resolve(owner, source.Path, source.Offset, source.Size, ".resS", "texture-stream");
        if (source.Size < (ulong)length) throw new BundleException("unity-bundle-texture-stream-range");
        if (inspectOnly) return [];
        var data = new byte[length];
        resource.Read(0, data);
        return data;
    }

    public ResourceSlice ResolveAudio(string owner, ResourceReference source) =>
        Resolve(owner, source.Path, source.Offset, source.Size, ".resource", "audio-stream");

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
