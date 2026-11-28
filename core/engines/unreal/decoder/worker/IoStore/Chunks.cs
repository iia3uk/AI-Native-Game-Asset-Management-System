using System.IO.Compression;
using CUE4Parse.UE4.IO.Objects;
using Microsoft.Win32.SafeHandles;
using CompressionMethod = CUE4Parse.Compression.CompressionMethod;

namespace AssetViewer.UnrealDecode.IoStore;

internal sealed class Chunks : IDisposable
{
    private readonly FIoStoreTocResource _toc;
    private readonly List<SafeFileHandle> _partitions = [];
    private readonly Block[] _blocks;
    private readonly record struct Block(int Partition, long Offset, int Stored, int Decoded, CompressionMethod Method);

    public Chunks(FIoStoreTocResource toc)
    {
        _toc = toc;
        _blocks = new Block[toc.CompressionBlocks.Length];
        try
        {
            var lengths = new long[toc.Header.PartitionCount];
            for (var i = 0; i < lengths.Length; i++)
            {
                var filename = i == 0 ? "input.ucas" : $"input_s{i}.ucas";
                var partition = File.OpenHandle(filename, FileMode.Open, FileAccess.Read, FileShare.Read);
                _partitions.Add(partition);
                lengths[i] = RandomAccess.GetLength(partition);
                if (lengths[i] <= 0 || (ulong)lengths[i] > toc.Header.PartitionSize)
                    throw new InputException("unreal-iostore-partition");
            }
            if (lengths.Sum() > 8L << 30) throw new InputException("unreal-iostore-size-limit");
            for (var i = 0; i < _blocks.Length; i++)
            {
                var block = toc.CompressionBlocks[i];
                var partition = (ulong)block.Offset / toc.Header.PartitionSize;
                var offset = (long)((ulong)block.Offset % toc.Header.PartitionSize);
                if (partition >= (ulong)lengths.Length || block.CompressedSize is 0 or > 2 * 1024 * 1024 ||
                    block.UncompressedSize == 0 || block.UncompressedSize > toc.Header.CompressionBlockSize ||
                    offset > lengths[partition] - block.CompressedSize ||
                    block.CompressionMethodIndex >= toc.CompressionMethods.Length)
                    throw InvalidBlock();
                var method = toc.CompressionMethods[block.CompressionMethodIndex];
                if (method == CompressionMethod.None && (block.CompressionMethodIndex != 0 ||
                    block.CompressedSize != block.UncompressedSize)) throw InvalidBlock();
                _blocks[i] = new((int)partition, offset, (int)block.CompressedSize, (int)block.UncompressedSize, method);
            }
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public bool Supports(FIoOffsetAndLength range)
    {
        var blockSize = _toc.Header.CompressionBlockSize;
        var end = range.Offset + range.Length;
        var first = range.Offset / blockSize;
        var last = (end - 1) / blockSize;
        if (last >= (ulong)_blocks.Length) throw InvalidBlock();

        var supported = true;
        for (var i = first; i <= last; i++)
        {
            var block = _blocks[i];
            if (Math.Min(end - i * blockSize, blockSize) > (ulong)block.Decoded) throw InvalidBlock();
            if (block.Method is not (CompressionMethod.None or CompressionMethod.Zlib)) supported = false;
        }
        return supported;
    }

    public byte[] Read(FIoOffsetAndLength range)
    {
        var output = new byte[range.Length];
        var blockSize = _toc.Header.CompressionBlockSize;
        var index = (int)(range.Offset / blockSize);
        var skip = (int)(range.Offset % blockSize);
        var written = 0;
        while (written < output.Length)
        {
            var block = _blocks[index++];
            var stored = new byte[block.Stored];
            var read = 0;
            while (read < stored.Length)
            {
                var count = RandomAccess.Read(_partitions[block.Partition], stored.AsSpan(read), block.Offset + read);
                if (count == 0) throw InvalidBlock();
                read += count;
            }

            var decoded = stored;
            if (block.Method == CompressionMethod.Zlib)
            {
                decoded = new byte[block.Decoded];
                using var input = new MemoryStream(stored, writable: false);
                using var zlib = new ZLibStream(input, CompressionMode.Decompress);
                try
                {
                    zlib.ReadExactly(decoded);
                    if (zlib.ReadByte() != -1) throw InvalidBlock();
                }
                catch (IOException) { throw InvalidBlock(); }
            }
            var countToCopy = Math.Min(decoded.Length - skip, output.Length - written);
            decoded.AsSpan(skip, countToCopy).CopyTo(output.AsSpan(written));
            written += countToCopy;
            skip = 0;
        }
        return output;
    }

    public void Dispose()
    {
        foreach (var partition in _partitions) partition.Dispose();
    }

    private static InputException InvalidBlock() => new("unreal-iostore-block");
}
