using AssetViewer.UnrealDecode.Objects;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.IO.Objects;
using CUE4Parse.UE4.Readers;

namespace AssetViewer.UnrealDecode.IoStore.Zen.Mesh;

internal sealed class ZenMeshExports(int headerSize, int selected, FExportMapEntry[] exports, byte[] commands)
{
    private static readonly ulong BodySetupClass = ZenPackage.ScriptClass("bodysetup");
    private const int BodyLimit = 2 * 1024 * 1024;

    public (string Name, byte[] Bytes)? ReadBody(byte[] chunk, byte[] mesh, ZenPackage package, ref int remainingBodies)
    {
        using var source = new FByteArchive("ZenStaticMesh", mesh, package.Version);
        using var archive = new FAssetArchive(source, package);
        TaggedProperties.Read(archive, _ => { });
        if (TaggedProperties.Boolean(archive)) archive.Position += 16;
        if (archive.Position + 10 > archive.Length || (archive.Read<byte>() & 1) == 0) throw ZenPackage.Invalid();
        _ = archive.Read<byte>();
        if (!TaggedProperties.Boolean(archive)) throw ZenPackage.Invalid();
        var reference = archive.Read<int>();
        if (reference == 0) return null;
        if (remainingBodies == 0) throw new InputException("limit");
        remainingBodies--;
        if (reference < 0 || reference > exports.Length) throw ZenPackage.Invalid();
        var index = reference - 1;
        var body = exports[index];
        if (body.ClassIndex.TypeAndId != BodySetupClass || body.OuterIndex.TypeAndId != (ulong)selected ||
            body.ObjectFlags.HasFlag(EObjectFlags.RF_ClassDefaultObject) || commands[index] != 3 ||
            body.ObjectName.IsGlobal || body.ObjectName.NameIndex >= package.NameMap.Length) throw ZenPackage.Invalid();
        if (body.CookedSerialSize > BodyLimit) throw new InputException("size");
        var dataSize = (ulong)(chunk.Length - headerSize);
        var start = body.CookedSerialOffset;
        var size = body.CookedSerialSize;
        if (size == 0 || start > dataSize || size > dataSize - start) throw ZenPackage.Invalid();
        for (var i = 0; i < exports.Length; i++)
        {
            if (i == index || exports[i].CookedSerialSize == 0) continue;
            var other = exports[i].CookedSerialOffset;
            if (other < start + size && (other >= start || exports[i].CookedSerialSize > start - other))
                throw ZenPackage.Invalid();
        }
        var name = ZenImports.NumberedName(package.NameMap[body.ObjectName.NameIndex].Name, body.ObjectName.ExtraIndex);
        if (!ZenImports.ValidObject(name)) throw ZenPackage.Invalid();
        return (name, chunk.AsSpan(headerSize + (int)start, (int)size).ToArray());
    }
}
