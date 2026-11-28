using System.Buffers.Binary;
using System.IO.Compression;
using System.IO.Hashing;

namespace AssetViewer.UnrealDecode.Formats;

internal static class Png
{
    public static long MaximumSize(int pixelBytes, int height) => pixelBytes + height + 64 * 1024L;

    public static void Write(Stream output, int width, int height, ReadOnlySpan<byte> rgba)
    {
        output.Write([137, 80, 78, 71, 13, 10, 26, 10]);
        Span<byte> header = stackalloc byte[13];
        header.Clear();
        BinaryPrimitives.WriteInt32BigEndian(header, width);
        BinaryPrimitives.WriteInt32BigEndian(header[4..], height);
        header[8] = 8;
        header[9] = 6;
        Chunk(output, "IHDR"u8, header);
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
        {
            var stride = width * 4;
            for (var row = 0; row < height; row++)
            {
                zlib.WriteByte(0);
                zlib.Write(rgba.Slice(row * stride, stride));
            }
        }
        Chunk(output, "IDAT"u8, compressed.GetBuffer().AsSpan(0, (int)compressed.Length));
        Chunk(output, "IEND"u8, []);
    }

    private static void Chunk(Stream output, ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        Span<byte> scalar = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(scalar, data.Length);
        output.Write(scalar);
        output.Write(type);
        output.Write(data);
        var crc = new Crc32();
        crc.Append(type);
        crc.Append(data);
        BinaryPrimitives.WriteUInt32BigEndian(scalar, crc.GetCurrentHashAsUInt32());
        output.Write(scalar);
    }
}
