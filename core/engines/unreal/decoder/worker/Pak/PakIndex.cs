using System.Buffers.Binary;
using System.Security.Cryptography;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Pak;
using CUE4Parse.UE4.Pak.Objects;
using CUE4Parse.UE4.Readers;

namespace AssetViewer.UnrealDecode.Pak;

internal static class PakIndex
{
    private const int MaxEntries = 10_000;
    private const int MaxIndexBytes = 32 * 1024 * 1024;

    public static IEnumerable<FPakEntry> Read(PakFileReader reader, FileStream stream)
    {
        var info = reader.Info;
        var index = ReadVerified(stream, info.IndexOffset, info.IndexSize, info.IndexHash);
        using var archive = new FByteArchive("Pak index", index, reader.Versions);
        CheckStringLength(archive, 768);
        var mount = archive.ReadFString();
        if (!mount.StartsWith("../../../", StringComparison.Ordinal) || !mount.EndsWith('/'))
            throw new InputException("unreal-pak-mount");
        var count = archive.Read<int>();
        if (count is < 0 or > MaxEntries) throw new InputException("unreal-pak-entry-limit");

        if ((int)info.Version < 10)
            return ReadClassic(reader, archive, mount[9..], count);

        archive.Position += sizeof(ulong); // Path hash seed.
        CheckSecondary(archive, stream, info);
        var directory = CheckSecondary(archive, stream, info);
        CheckDirectorySize(directory);
        reader.Mount(StringComparer.Ordinal);
        if (reader.Files.Count > count) throw new InputException("unreal-pak-entry-limit");
        return reader.Files.Values.OfType<FPakEntry>();
    }

    private static List<FPakEntry> ReadClassic(PakFileReader reader, FByteArchive archive, string mount, int count)
    {
        var result = new List<FPakEntry>(count);
        for (var i = 0; i < count; i++)
        {
            CheckStringLength(archive, 768);
            var name = archive.ReadFString();
            if (name.Length == 0) throw new InputException("unreal-pak-path");
            result.Add(new FPakEntry(reader, mount + name, archive));
        }
        return result;
    }

    private static void CheckStringLength(FByteArchive archive, int maxCharacters)
    {
        var start = archive.Position;
        var characters = archive.Read<int>();
        var bytes = characters >= 0 ? characters : -2L * characters;
        if (characters < -maxCharacters - 1 || characters > maxCharacters + 1 ||
            bytes > archive.Length - archive.Position)
            throw new InputException("unreal-pak-path");
        archive.Position = start;
    }

    private static byte[] ReadVerified(FileStream stream, long offset, long size, FSHAHash expected)
    {
        if (size is < 1 or > MaxIndexBytes || offset < 0 || offset > stream.Length - size)
            throw new InputException("unreal-pak-index-limit");
        var index = new byte[(int)size];
        stream.Position = offset;
        stream.ReadExactly(index);
        if (new FSHAHash(SHA1.HashData(index)) != expected)
            throw new InputException("unreal-pak-index-hash");
        return index;
    }

    private static byte[] CheckSecondary(FByteArchive primary, FileStream stream, FPakInfo info)
    {
        if (!primary.ReadBoolean()) throw new InputException("unreal-pak-layout");
        var offset = primary.Read<long>();
        var size = primary.Read<long>();
        var hash = new FSHAHash(primary);
        if (offset < info.IndexOffset + info.IndexSize) throw new InputException("unreal-pak-index-limit");
        return ReadVerified(stream, offset, size, hash);
    }

    private static void CheckDirectorySize(byte[] directory)
    {
        if (directory.Length < 4) throw new InputException("unreal-pak-layout");
        var count = BinaryPrimitives.ReadInt32LittleEndian(directory);
        if (count == 0x50464451) // Newer flat directory index.
        {
            if (directory.Length < 32) throw new InputException("unreal-pak-layout");
            var files = BinaryPrimitives.ReadInt32LittleEndian(directory.AsSpan(8));
            count = BinaryPrimitives.ReadInt32LittleEndian(directory.AsSpan(4));
            if (files is < 0 or > MaxEntries) throw new InputException("unreal-pak-entry-limit");
        }
        if (count is < 0 or > MaxEntries) throw new InputException("unreal-pak-entry-limit");
    }
}
