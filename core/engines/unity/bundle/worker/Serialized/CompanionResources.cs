using AssetViewer.UnityBundle.Objects.Resources;

namespace AssetViewer.UnityBundle.Serialized;

internal sealed record CompanionNames(string? Texture, string? Audio, string? AudioStem);

internal sealed class CompanionResources(CompanionNames? names) : SerializedResources, IDisposable
{
    private readonly Dictionary<string, Stream> streams = [];
    public override string TextureStorage => "companion";

    protected override ResourceSlice Resolve(string owner, string path, ulong offset, ulong size, string suffix, string issue)
    {
        if (path.Length is < 1 or > 180 || path.Any(c => c is '/' or '\\' or ':' || char.IsControl(c)))
            throw new BundleException($"unity-bundle-{issue}-path");
        // The recorded path can only select a fixed file staged from a sibling of the primary file.
        var staged = suffix switch
        {
            ".resS" when path == names?.Texture => "input.resS",
            ".resource" when path == names?.Audio => "input.resource",
            ".resource" when path == names?.AudioStem => "input-stem.resource",
            _ => throw new BundleException($"unity-bundle-{issue}-path"),
        };
        if (!streams.TryGetValue(staged, out var stream))
        {
            try
            {
                streams.Add(staged, stream = File.OpenRead(staged));
            }
            catch (FileNotFoundException)
            {
                throw new BundleException($"unity-bundle-{issue}-missing");
            }
        }
        var available = (ulong)stream.Length;
        if (available > 256UL << 20 || offset > available || size > available - offset)
            throw new BundleException($"unity-bundle-{issue}-range");
        return new ResourceSlice(stream, (long)offset, (long)size);
    }

    public void Dispose()
    {
        foreach (var stream in streams.Values) stream.Dispose();
    }
}
