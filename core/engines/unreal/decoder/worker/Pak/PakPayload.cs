using System.IO.Compression;
using System.Security.Cryptography;
using CUE4Parse.Compression;
using CUE4Parse.UE4.Pak;
using CUE4Parse.UE4.Pak.Objects;

namespace AssetViewer.UnrealDecode.Pak;

internal static class PakPayload
{
    public static bool Supports(FPakEntry file) =>
        file.CompressionMethod == CompressionMethod.None ||
        file.CompressionMethod == CompressionMethod.Zlib && file.CompressionBlocks.Length > 0;

    public static void CheckBounds(FPakEntry file, FPakInfo info)
    {
        if (file.Offset < 0 || file.StructSize < 48 ||
            file.Offset > info.IndexOffset - file.StructSize - file.CompressedSize)
            throw new InputException("unreal-pak-payload-offset");

        if (file.CompressionMethod == CompressionMethod.None)
        {
            if (file.CompressedSize != file.UncompressedSize)
                throw new InputException("unreal-pak-payload-size");
            return;
        }

        var blockSize = file.CompressionBlockSize;
        if (blockSize == 0 || file.CompressionBlocks.Length != (file.UncompressedSize + blockSize - 1) / blockSize)
            throw new InputException("unreal-pak-compression-blocks");
        var next = file.Offset + file.StructSize;
        var end = next + file.CompressedSize;
        foreach (var block in file.CompressionBlocks)
        {
            if (block.CompressedStart != next || block.CompressedEnd <= next || block.CompressedEnd > end)
                throw new InputException("unreal-pak-compression-blocks");
            next = block.CompressedEnd;
        }
        if (next != end) throw new InputException("unreal-pak-compression-blocks");
    }

    public static byte[] Read(PakFileReader reader, FileStream stream, FPakEntry file)
    {
        if (file.CompressionMethod == CompressionMethod.None)
        {
            var payload = reader.Extract(file);
            VerifyStoredHash(stream, file, reader.Info, payload);
            return payload;
        }

        var compressed = new byte[(int)file.CompressedSize];
        stream.Position = file.Offset + file.StructSize;
        stream.ReadExactly(compressed);
        VerifyStoredHash(stream, file, reader.Info, compressed);

        var decoded = new byte[(int)file.UncompressedSize];
        var written = 0;
        var start = 0;
        foreach (var block in file.CompressionBlocks)
        {
            var size = (int)block.Size;
            var available = Math.Min(decoded.Length - written, (long)file.CompressionBlockSize);
            using var contiguous = new MemoryStream(compressed, start, size, false);
            using var codec = new ZLibStream(contiguous, CompressionMode.Decompress);
            codec.ReadExactly(decoded.AsSpan(written, (int)available));
            if (codec.ReadByte() != -1) throw new InputException("unreal-pak-payload-size");
            written += (int)available;
            start += size;
        }
        return decoded;
    }

    private static void VerifyStoredHash(FileStream stream, FPakEntry file, FPakInfo info, byte[] stored)
    {
        Span<byte> expected = stackalloc byte[20];
        var flags = (int)info.Version >= 3 ? 5 : 0;
        var blocks = file.CompressionMethod == CompressionMethod.None ? 0 : 4 + 16 * file.CompressionBlocks.Length;
        stream.Position = file.Offset + file.StructSize - expected.Length - flags - blocks;
        stream.ReadExactly(expected);
        if (!SHA1.HashData(stored).AsSpan().SequenceEqual(expected))
            throw new InputException("unreal-pak-payload-hash");
    }
}
