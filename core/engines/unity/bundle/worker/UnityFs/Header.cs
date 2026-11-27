using System.Buffers.Binary;
using System.Text;
using System.Text.RegularExpressions;

namespace AssetViewer.UnityBundle.UnityFs;

internal sealed record Header(uint Format, string Version)
{
    public const long InputLimit = 128L << 20;

    public static Header Read(Stream stream)
    {
        if (stream.Length is < 48 or > InputLimit) throw new BundleException("unity-bundle-input-size");
        if (ReadString(stream) != "UnityFS") throw new BundleException("unity-bundle-signature");
        Span<byte> formatBytes = stackalloc byte[4];
        stream.ReadExactly(formatBytes);
        var format = BinaryPrimitives.ReadUInt32BigEndian(formatBytes);
        if (format is < 6 or > 8) throw new BundleException("unity-bundle-version");
        _ = ReadString(stream);
        var version = ReadString(stream);
        if (!Regex.IsMatch(version, @"^\d{1,4}\.\d{1,3}\.\d{1,4}[abfp]\d{1,4}$"))
            throw new BundleException("unity-bundle-engine-version");

        Span<byte> sizes = stackalloc byte[20];
        stream.ReadExactly(sizes);
        var length = BinaryPrimitives.ReadInt64BigEndian(sizes);
        var compressed = BinaryPrimitives.ReadUInt32BigEndian(sizes[8..]);
        var unpacked = BinaryPrimitives.ReadUInt32BigEndian(sizes[12..]);
        var flags = BinaryPrimitives.ReadUInt32BigEndian(sizes[16..]);
        if ((flags & ~0x2ffU) != 0 || (flags & 0x40U) == 0 || !SupportedCodec(flags))
            throw new BundleException("unity-bundle-layout");
        var headerEnd = format >= 7 ? (stream.Position + 15) & ~15L : stream.Position;
        if (length != stream.Length || compressed == 0 || unpacked is < 24 or > 1048576 ||
            compressed > unpacked + 8192 || compressed > length - headerEnd ||
            ((flags & 0x3f) == 0 && compressed != unpacked))
            throw new BundleException("unity-bundle-metadata-size");
        return new Header(format, version);
    }

    public static bool SupportedCodec(uint flags) => (flags & 0x3f) is 0 or 2 or 3;

    private static string ReadString(Stream stream)
    {
        Span<byte> bytes = stackalloc byte[48];
        for (var index = 0; index < bytes.Length; index++)
        {
            var value = stream.ReadByte();
            if (value == 0) return Encoding.ASCII.GetString(bytes[..index]);
            if (value is < 0x20 or > 0x7e) break;
            bytes[index] = (byte)value;
        }
        throw new BundleException("unity-bundle-header");
    }
}
