using System.Buffers.Binary;
using CUE4Parse.UE4.IO.Objects;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;

namespace AssetViewer.UnrealDecode.IoStore;

internal sealed class Toc
{
    private const int HeaderSize = 144;
    private const int MiB = 1024 * 1024;
    public readonly FIoStoreTocResource Resource;
    public readonly DirectoryFile[] Files;
    private readonly byte[] _bytes;
    private readonly int _metadataOffset;
    private readonly int _metadataStride;

    public Toc()
    {
        using var stream = File.OpenRead("input.utoc");
        if (stream.Length is < HeaderSize or > 32 * MiB) throw new InputException("unreal-iostore-size-limit");
        _bytes = new byte[stream.Length];
        stream.ReadExactly(_bytes);
        if (!_bytes.AsSpan(0, 16).SequenceEqual("-==--==--==--==-"u8)) throw Invalid();
        var version = _bytes[16];
        var flags = (EIoContainerFlags)_bytes[80];
        if (flags.HasFlag(EIoContainerFlags.Encrypted)) throw new InputException("unreal-iostore-encrypted");
        if (flags.HasFlag(EIoContainerFlags.Signed)) throw new InputException("unreal-iostore-signed");
        if (version is < 2 or > 8 || (flags & ~(EIoContainerFlags.Indexed | EIoContainerFlags.Compressed)) != 0)
            throw new InputException("unreal-iostore-version");
        if (!flags.HasFlag(EIoContainerFlags.Indexed)) throw new InputException("unreal-iostore-no-directory");

        var chunks = UInt32(24);
        var blocks = UInt32(28);
        var methods = UInt32(36);
        var methodWidth = UInt32(40);
        var blockSize = UInt32(44);
        var directorySize = UInt32(48);
        var partitions = version < 3 ? 1 : UInt32(52);
        var seeds = version < 4 ? 0 : UInt32(84);
        var overflow = version < 5 ? 0 : UInt32(96);
        if (UInt32(20) != HeaderSize || UInt32(32) != 12 || chunks is < 1 or > 100_000 || blocks is < 1 or > 250_000 ||
            methods > 16 || methodWidth > 32 || (methods != 0 && methodWidth == 0) || blockSize is < 16 or > MiB ||
            (blockSize & (blockSize - 1)) != 0 || directorySize is < 16 or > 8 * MiB ||
            partitions is < 1 or > 8 || (version >= 3 && BinaryPrimitives.ReadUInt64LittleEndian(_bytes.AsSpan(88)) == 0) ||
            seeds > chunks || overflow > chunks) throw Invalid();

        var overflowStart = (int)(HeaderSize + chunks * 22 + seeds * 4);
        var directoryStart = (int)(overflowStart + overflow * 4 + blocks * 12 + methods * methodWidth);
        _metadataOffset = directoryStart + (int)directorySize;
        _metadataStride = version < 8 ? 33 : 24;
        if (_metadataOffset + chunks * _metadataStride != _bytes.Length) throw Invalid();
        for (var i = 0; i < overflow; i++)
            if (UInt32(overflowStart + i * 4) >= chunks) throw Invalid();

        Files = DirectoryIndex.Read(_bytes.AsMemory(directoryStart, (int)directorySize), (int)chunks);
        // The bounded stock TOC tables can now be passed to the pinned reader.
        using var archive = new FByteArchive("input.utoc", _bytes, new VersionContainer(EGame.GAME_UE5_LATEST));
        Resource = new FIoStoreTocResource(archive);
    }

    public ReadOnlySpan<byte> ChunkHash(int index) => _bytes.AsSpan(_metadataOffset + index * _metadataStride, 20);
    public string ChunkId(int index) => Convert.ToHexStringLower(_bytes.AsSpan(HeaderSize + index * 12, 12));

    private uint UInt32(int offset) => BinaryPrimitives.ReadUInt32LittleEndian(_bytes.AsSpan(offset));
    private static InputException Invalid() => new("unreal-iostore-layout");
}
