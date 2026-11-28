using System.Text;
using AssetViewer.UnrealDecode.Pak;

namespace AssetViewer.UnrealDecode.IoStore;

internal readonly record struct DirectoryFile(string Path, int Chunk);

internal static class DirectoryIndex
{
    private const uint Invalid = uint.MaxValue;
    private const int MaxFiles = 10_000;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly UnicodeEncoding Utf16 = new(false, false, true);
    private readonly record struct DirectoryRow(uint Name, uint Child, uint Sibling, uint File);
    private readonly record struct FileRow(uint Name, uint Next, uint Chunk);

    public static DirectoryFile[] Read(ReadOnlyMemory<byte> bytes, int chunks)
    {
        using var stream = new MemoryStream(bytes.ToArray(), writable: false);
        using var reader = new BinaryReader(stream);
        var mount = ReadString(reader);
        if (mount.StartsWith("../../../", StringComparison.Ordinal)) mount = mount[9..];
        if (mount.Length > 0 && !mount.EndsWith('/')) throw InvalidPath();
        if (mount.Length > 1) CheckPath(mount[..^1]);
        if (mount == "/") throw InvalidPath();
        var directories = new DirectoryRow[ReadCount(reader, MaxFiles, 16)];
        for (var i = 0; i < directories.Length; i++)
            directories[i] = new(reader.ReadUInt32(), reader.ReadUInt32(), reader.ReadUInt32(), reader.ReadUInt32());
        var files = new FileRow[ReadCount(reader, MaxFiles, 12)];
        for (var i = 0; i < files.Length; i++)
            files[i] = new(reader.ReadUInt32(), reader.ReadUInt32(), reader.ReadUInt32());
        var names = new string[ReadCount(reader, MaxFiles * 2, 4)];
        for (var i = 0; i < names.Length; i++) names[i] = ReadString(reader);
        if (stream.Position != stream.Length || directories.Length == 0 ||
            directories[0].Name != Invalid || directories[0].Sibling != Invalid) throw InvalidLayout();
        return Traverse(mount, chunks, directories, files, names);
    }

    private static DirectoryFile[] Traverse(string mount, int chunks, DirectoryRow[] directories, FileRow[] files, string[] names)
    {
        var pending = new Stack<(uint Index, string Prefix, int Depth)>();
        var seenDirectories = new HashSet<uint>();
        var seenFiles = new HashSet<uint>();
        var seenChunks = new HashSet<uint>();
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<DirectoryFile>(files.Length);
        pending.Push((0, mount, 0));
        while (pending.TryPop(out var current))
        {
            var (index, prefix, depth) = current;
            if (index >= directories.Length || !seenDirectories.Add(index) || depth > 24) throw InvalidLayout();
            var directory = directories[index];
            var path = index == 0 ? prefix : prefix + ReadName(directory.Name, names) + "/";
            if (path.Length > 768) throw InvalidPath();
            if (directory.Sibling != Invalid) pending.Push((directory.Sibling, prefix, depth));
            if (directory.Child != Invalid) pending.Push((directory.Child, path, depth + 1));
            for (var fileIndex = directory.File; fileIndex != Invalid;)
            {
                if (fileIndex >= files.Length || !seenFiles.Add(fileIndex)) throw InvalidLayout();
                var file = files[fileIndex];
                if (file.Chunk >= chunks || !seenChunks.Add(file.Chunk)) throw InvalidLayout();
                var fullPath = CheckPath(path + ReadName(file.Name, names));
                if (!paths.Add(fullPath.Normalize())) throw InvalidPath();
                result.Add(new(fullPath, (int)file.Chunk));
                fileIndex = file.Next;
            }
        }
        if (seenDirectories.Count != directories.Length || seenFiles.Count != files.Length) throw InvalidLayout();
        return result.OrderBy(file => file.Path, StringComparer.Ordinal).ToArray();
    }

    private static string ReadName(uint index, string[] names)
    {
        if (index >= names.Length) throw InvalidLayout();
        var name = names[index];
        if (name.Contains('/')) throw InvalidPath();
        return CheckPath(name);
    }

    private static string CheckPath(string path)
    {
        try { return PakPaths.Check(path); }
        catch (InputException) { throw InvalidPath(); }
    }

    private static int ReadCount(BinaryReader reader, int maximum, int width)
    {
        var count = reader.ReadInt32();
        if (count < 0 || count > maximum || (long)count * width > Remaining(reader)) throw InvalidLayout();
        return count;
    }

    private static string ReadString(BinaryReader reader)
    {
        var count = reader.ReadInt32();
        if (count == 0) return "";
        if (count is < -769 or > 3073) throw InvalidLayout();
        var wide = count < 0;
        var size = wide ? -2 * count : count;
        var nullBytes = wide ? 2 : 1;
        if (size > Remaining(reader)) throw InvalidLayout();
        var bytes = reader.ReadBytes(size);
        if (bytes[^1] != 0 || (wide && bytes[^2] != 0)) throw InvalidLayout();
        return (wide ? (Encoding)Utf16 : Utf8).GetString(bytes, 0, bytes.Length - nullBytes);
    }

    private static long Remaining(BinaryReader reader) => reader.BaseStream.Length - reader.BaseStream.Position;
    private static InputException InvalidLayout() => new("unreal-iostore-directory");
    private static InputException InvalidPath() => new("unreal-iostore-path");
}
