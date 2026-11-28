using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;

namespace AssetViewer.UnrealDecode.Objects;

internal sealed record MeshSection(int Slot, int FirstIndex, int Triangles, string? Name, string? Material, bool Collision);
internal sealed record MeshLod(int Lod, int Vertices, int Uvs, bool Colors, int Indices, long Size, bool TangentsQuantized, MeshSection[] Sections);
internal sealed record MeshExport(MeshLod[] Lods, int[] Missing, bool Limited);

internal static class CookedStaticMesh
{
    public static MeshExport? Read(CookedInput? input, CookedInput? exports, CookedInput? bulk,
        CookedInput? optional, string stem, long remaining)
        => CookedPackage.Read<UStaticMesh, MeshExport?>(input, exports, bulk, optional,
            "StaticMesh", "unreal-cooked-mesh", (asset, package) => Write(asset, stem, remaining,
                slot => Material(asset.StaticMaterials[slot], package)));

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

    public static string? SlotName(FStaticMaterial row)
    {
        var name = row.MaterialSlotName.Text;
        return name.Length is 0 or > 128 || name.Any(char.IsControl) || name == "None" ? null : name;
    }

    private static (string? Name, string? Path) Material(FStaticMaterial row, Package package)
    {
        var name = SlotName(row);
        var index = row.MaterialInterface?.Index ?? 0;
        if (index >= 0 || index < -package.ImportMap.Length) return (name, null);
        var import = package.ImportMap[-index - 1];
        var parent = import.OuterIndex?.Index ?? 0;
        if (import.ClassName.Text is not ("Material" or "MaterialInstanceConstant") ||
            parent >= 0 || parent < -package.ImportMap.Length) return (name, null);
        var owner = package.ImportMap[-parent - 1];
        var path = owner.ObjectName.Text;
        if (owner.OuterIndex?.Index != 0 || owner.ClassName.Text != "Package" || path.Length is 0 or > 320 ||
            path[0] != '/' || path.Any(char.IsControl) || path.Contains('\\') || import.ObjectName.Text != path[(path.LastIndexOf('/') + 1)..])
            return (name, null);
        return (name, path);
    }
}
