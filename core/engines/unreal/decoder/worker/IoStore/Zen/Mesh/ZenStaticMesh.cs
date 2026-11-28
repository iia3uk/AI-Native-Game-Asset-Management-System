using System.Runtime.CompilerServices;
using AssetViewer.UnrealDecode.Objects;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Assets.Utils;
using CUE4Parse.UE4.IO.Objects;
using CUE4Parse.UE4.Readers;
using static CUE4Parse.UE4.Assets.Objects.EBulkDataFlags;

namespace AssetViewer.UnrealDecode.IoStore.Zen.Mesh;

internal sealed record ZenMaterialSlot(int Slot, ZenReference Reference);

internal static class ZenStaticMesh
{
    private const int BulkLimit = 48 * 1024 * 1024;

    // The pinned CUE4Parse reader accepts an export-local map on its asset archive.
    // Supplying it here keeps the stock mesh reader independent of a global game provider.
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "BulkDataMap")]
    private static extern ref FBulkDataMapEntry[]? BulkMap(FAssetArchive archive);

    public static (MeshExport Mesh, List<ZenMaterialSlot> Materials) Read(byte[] bytes, ZenPackage package, IReadOnlyDictionary<string, string> sidecars,
        string stem, long remaining)
    {
        if (remaining <= 0) throw new InputException("limit");
        if (package.Bulk.Any(entry => entry.SerialSize > BulkLimit || entry.SerialOffset > long.MaxValue))
            throw new InputException("bulk-layout");

        using var source = new FByteArchive("ZenStaticMesh", bytes, package.Version);
        using var archive = new FAssetArchive(source, package);
        TaggedProperties.Read(archive, _ => { });
        archive.Position = 0;
        BulkMap(archive) = package.Bulk;

        long payloadBytes = 0;
        FArchive? Payload(string extension, FByteBulkDataHeader? header)
        {
            if (header is not { } item || !item.CookedIndex.IsDefault || item.ElementCount is <= 0 or > BulkLimit ||
                item.SizeOnDisk != item.ElementCount || item.OffsetInFile < 0 ||
                item.BulkDataFlags.HasFlag(BULKDATA_SerializeCompressedZLIB) ||
                !sidecars.TryGetValue(extension, out var file)) return null;
            using var stream = File.OpenRead(file);
            if (item.OffsetInFile > stream.Length - item.ElementCount ||
                payloadBytes + item.ElementCount > 2L * BulkLimit) return null;
            payloadBytes += item.ElementCount;
            stream.Position = item.OffsetInFile;
            var payload = new byte[item.ElementCount];
            stream.ReadExactly(payload);
            return new FByteArchive("ZenMeshLod", payload, package.Version);
        }
        archive.AddPayload(PayloadType.UBULK, 0, header => Payload(".ubulk", header));
        archive.AddPayload(PayloadType.UPTNL, 0, header => Payload(".uptnl", header));
        archive.AddPayload(PayloadType.MUBULK, 0, header => Payload(".m.ubulk", header));

        var asset = new UStaticMesh();
        asset.Deserialize(archive, bytes.Length);
        if (archive.Position != bytes.Length) throw ZenPackage.Invalid();
        var mesh = CookedStaticMesh.Write(asset, stem, remaining,
            slot => (CookedStaticMesh.SlotName(asset.StaticMaterials[slot]), null));
        var materials = new List<ZenMaterialSlot>();
        for (var slot = 0; slot < asset.StaticMaterials.Length; slot++)
            if (package.Reference(asset.StaticMaterials[slot].MaterialInterface?.Index ?? 0) is { } reference)
                materials.Add(new(slot, reference));
        return (mesh, materials);
    }
}
