using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;

namespace AssetViewer.UnrealDecode.Objects;

internal static class CookedStaticMesh
{
    public static MeshExport Write(UStaticMesh asset, Package package, string stem, long remaining) =>
        Write(asset, stem, remaining, slot =>
        {
            var material = asset.StaticMaterials[slot];
            return CookedMaterials.Read(material.MaterialSlotName.Text, material.MaterialInterface?.Index ?? 0, package);
        });

    public static MeshExport Write(UStaticMesh asset, string stem, long remaining,
        Func<int, (string? Name, string? Path)> material)
    {
        if (!asset.bCooked || asset.RenderData?.LODs is not { Length: >= 1 and <= 8 } lods || asset.StaticMaterials.Length > 128)
            throw new InputException("unreal-cooked-mesh-layout");

        var result = new List<MeshLod>();
        var missing = new List<int>();
        var limited = false;
        for (var level = 0; level < lods.Length; level++)
        {
            var lod = lods[level];
            var product = MeshBuffers.Describe(lod, level,
                slot => slot < asset.StaticMaterials.Length ? material(slot) : (null, null));
            if (product == null || product.Size > remaining)
            {
                limited |= product != null;
                missing.Add(level);
                continue;
            }
            using var output = File.Open(Path.Combine("output", stem + "-" + level + ".mesh"), FileMode.CreateNew, FileAccess.Write);
            MeshBuffers.Write(lod, product, output);
            if (output.Length != product.Size) throw new InputException("unreal-cooked-mesh-output");
            remaining -= product.Size;
            result.Add(product);
        }
        if (result.Count == 0) throw new InputException(limited ? "unreal-cooked-mesh-limit" : "unreal-cooked-mesh-buffers");
        return new MeshExport(result.ToArray(), missing.ToArray(), limited);
    }

    public static string? SlotName(FStaticMaterial row) => CookedMaterials.SlotName(row.MaterialSlotName.Text);

}
