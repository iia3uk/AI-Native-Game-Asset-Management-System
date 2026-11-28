using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetViewer.UnityBundle.Serialized.Player;

namespace AssetViewer.UnityBundle.Serialized;

internal static class SerializedFile
{
    private const string Input = "input.bundle";
    private const string Member = "input.assets";

    public static Report Read(bool inspectOnly, long outputLimit, CompanionNames? companions)
    {
        using var input = File.OpenRead(Input);
        if (input.Length is < 48 or > 128L << 20)
            throw new BundleException("unity-bundle-input-size");
        using var reader = new AssetsFileReader(input);
        var header = new AssetsFileHeader();
        header.Read(reader);
        if (header.Version is not (22 or 23) || header.Endianness || header.FileSize != input.Length ||
            header.MetadataSize is <= 0 or > 32L << 20 || header.DataOffset > input.Length ||
            header.DataOffset < reader.Position + header.MetadataSize)
            throw new BundleException("unity-bundle-serialized-header");
        input.Position = 0;
        var manager = new AssetsManager();
        try
        {
            var file = manager.LoadAssetsFile(input, Member, false);
            var assets = new List<Asset>();
            var materialBudget = 8192;
            using var resources = new CompanionResources(companions);
            SerializedObjects.Read(manager, file, Member, input.Length, resources, inspectOnly,
                assets, ref outputLimit, ref materialBudget, PlayerLayout.Supports(file.file));
            return new Report(1, Program.DecoderRevision, "completed", header.Version,
                file.file.Metadata.UnityVersion, assets);
        }
        finally
        {
            manager.UnloadAll();
        }
    }
}
