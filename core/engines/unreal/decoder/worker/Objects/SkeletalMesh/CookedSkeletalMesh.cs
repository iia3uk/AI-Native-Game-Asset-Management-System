using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;

namespace AssetViewer.UnrealDecode.Objects;

internal static class CookedSkeletalMesh
{
    public static MeshExport Write(USkeletalMesh asset, Package package, string stem, long remaining)
    {
        var boneCount = asset.ReferenceSkeleton.FinalRefBoneInfo.Length;
        if (boneCount is < 1 or > 2048 || asset.ReferenceSkeleton.FinalRefBonePose.Length != boneCount ||
            asset.LODModels is not { Length: >= 1 and <= 8 } lods || asset.SkeletalMaterials.Length > 128)
            throw new InputException("unreal-cooked-mesh-layout");

        var products = new List<MeshLod>();
        var missing = new List<int>();
        var limited = false;
        for (var level = 0; level < lods.Length; level++)
        {
            var buffers = SkeletalBuffers.Read(lods[level], level, boneCount, slot => Material(asset, package, slot));
            if (buffers == null || buffers.Product.Size > remaining)
            {
                limited |= buffers != null;
                missing.Add(level);
                continue;
            }
            using var output = File.Open(Path.Combine("output", stem + "-" + level + ".mesh"), FileMode.CreateNew, FileAccess.Write);
            buffers.Write(output);
            if (output.Length != buffers.Product.Size) throw new InputException("unreal-cooked-mesh-output");
            remaining -= buffers.Product.Size;
            products.Add(buffers.Product);
        }
        if (products.Count == 0) throw new InputException(limited ? "unreal-cooked-mesh-limit" : "unreal-cooked-mesh-skin-buffers");
        return new MeshExport(products.ToArray(), missing.ToArray(), limited, boneCount);
    }

    private static (string? Name, string? Path) Material(USkeletalMesh asset, Package package, int slot)
    {
        if (slot >= asset.SkeletalMaterials.Length) return (null, null);
        var material = asset.SkeletalMaterials[slot];
        return CookedMaterials.Read(material.MaterialSlotName.Text, material.MaterialInterface?.Index ?? 0, package);
    }
}
