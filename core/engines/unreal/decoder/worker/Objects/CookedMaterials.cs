using CUE4Parse.UE4.Assets;

namespace AssetViewer.UnrealDecode.Objects;

internal static class CookedMaterials
{
    public static string? SlotName(string? name) =>
        name == null || name.Length is 0 or > 128 || name.Any(char.IsControl) || name == "None" ? null : name;

    public static (string? Name, string? Path) Read(string? slotName, int index, Package package)
    {
        var name = SlotName(slotName);
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
