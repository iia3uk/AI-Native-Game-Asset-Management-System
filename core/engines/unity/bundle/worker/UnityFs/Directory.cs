using System.Text.RegularExpressions;
using AssetsTools.NET;

namespace AssetViewer.UnityBundle.UnityFs;

internal static class BundleDirectory
{
    public static void Validate(AssetBundleFile bundle)
    {
        var info = bundle.BlockAndDirInfo;
        if (info.DirectoryInfos.Count is 0 or > 256 || info.BlockInfos.Length is 0 or > 8192)
            throw new BundleException("unity-bundle-entry-limit");
        long length = 0;
        long compressed = 0;
        foreach (var block in info.BlockInfos)
        {
            if ((block.Flags & ~0x7f) != 0 || !Header.SupportedCodec(block.Flags) ||
                block.DecompressedSize == 0 || block.CompressedSize == 0 ||
                ((block.Flags & 0x3f) == 0 && block.CompressedSize != block.DecompressedSize))
                throw new BundleException("unity-bundle-block");
            length += block.DecompressedSize;
            compressed += block.CompressedSize;
        }
        if (length > 256L << 20 || compressed > bundle.Reader.BaseStream.Length)
            throw new BundleException("unity-bundle-unpacked-size");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long previousEnd = 0;
        foreach (var entry in info.DirectoryInfos.OrderBy(entry => entry.Offset))
        {
            if (!Regex.IsMatch(entry.Name, @"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\z") || !names.Add(entry.Name))
                throw new BundleException("unity-bundle-entry-name");
            if (entry.Offset < previousEnd || entry.Offset > length || entry.DecompressedSize <= 0 ||
                entry.DecompressedSize > length - entry.Offset)
                throw new BundleException("unity-bundle-entry-range");
            previousEnd = entry.Offset + entry.DecompressedSize;
        }
    }
}
