using CUE4Parse.UE4.IO.Objects;
using CUE4Parse.UE4.Readers;

namespace AssetViewer.UnrealDecode.IoStore.Zen;

internal sealed record ZenIdentity(string Package, string Object, string Hash);
internal sealed record ZenReference(string Package, string Hash);
internal sealed record ZenSoftReference(string Package, string Object);

internal sealed class ZenImports(string[] names, ulong[] hashes, ulong[] objects)
{
    public static ZenImports Read(FByteArchive archive, byte[] bytes, FZenPackageSummary header)
    {
        var hashSize = header.ImportMapOffset - header.ImportedPublicExportHashesOffset;
        var importSize = header.ExportMapOffset - header.ImportMapOffset;
        if (hashSize is < 0 or > 32768 || importSize is < 0 or > 32768 || (hashSize | importSize) % 8 != 0)
            throw ZenPackage.Invalid();
        archive.Position = header.ImportedPublicExportHashesOffset;
        var hashes = archive.ReadArray<ulong>(hashSize / 8);
        var objects = archive.ReadArray<ulong>(importSize / 8);

        var start = header.ImportedPackageNamesOffset;
        var end = (int)header.HeaderSize;
        if (start + 4L > end) throw ZenPackage.Invalid();
        archive.Position = start;
        var count = archive.Read<int>();
        if (count is < 0 or > 4096) throw ZenPackage.Invalid();
        if (count == 0) return new([], hashes, objects);
        var namesEnd = end - count * 4;
        var batch = ZenPackage.ReadNames(archive, bytes, start, namesEnd);
        if (archive.Position != namesEnd) throw ZenPackage.Invalid();
        var names = new string[count];
        for (var i = 0; i < names.Length; i++)
        {
            var number = archive.Read<int>();
            if (number < 0) throw ZenPackage.Invalid();
            names[i] = NumberedName(batch[i].Name, (uint)number);
        }
        return new(names, hashes, objects);
    }

    public ZenReference? Resolve(int index)
    {
        var import = -(long)index - 1;
        if (import < 0 || import >= objects.Length) return null;
        var entry = new FPackageObjectIndex(objects[import]);
        if (!entry.IsPackageImport) return null;
        var target = entry.AsPackageImportRef;
        if (target.ImportedPackageIndex >= names.Length || target.ImportedPublicExportHashIndex >= hashes.Length) return null;
        var package = names[target.ImportedPackageIndex];
        var hash = hashes[target.ImportedPublicExportHashIndex];
        return hash != 0 && ValidPackage(package) ? new(package, hash.ToString("x16")) : null;
    }

    public static string NumberedName(string? name, uint number) => name == null ? "" : number == 0 ? name : $"{name}_{number - 1}";
    public static bool ValidObject(string name) => name.Length is > 0 and <= 256 &&
        name.All(ch => !char.IsControl(ch) && ch is not ('/' or '\\' or '.' or ':'));
    public static bool ValidPackage(string path) => path.Length is > 1 and <= 768 && path[0] == '/' &&
        path[1..].Split('/').All(ValidObject);
}
