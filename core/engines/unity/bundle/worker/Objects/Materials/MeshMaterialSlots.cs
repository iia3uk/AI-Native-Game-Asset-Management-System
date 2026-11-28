using AssetsTools.NET;
using System.Text.Json.Serialization;
using AssetViewer.UnityBundle.Serialized;

namespace AssetViewer.UnityBundle.Objects.Materials;

internal sealed record MeshBindings(string Status, ObjectReference?[]? Slots = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? RendererMember = null);

internal static class MeshMaterialSlots
{
    public static void Read(SerializedMember member, ObjectTables tables, Dictionary<ObjectAddress, MeshBindings> result)
    {
        if (!member.File.Metadata.TypeTreeEnabled) return;
        var objects = tables.In(member);
        var filters = new Dictionary<long, HashSet<ObjectAddress>>();
        foreach (var info in objects.Values)
        {
            if (info.GetTypeId(member.File) != 33 || info.ByteSize > 2L << 20) continue;
            try
            {
                var filter = member.ReadField(info);
                var mesh = tables.Address(member, tables.ReadReference(member, filter["m_Mesh"]), 43);
                var owner = ObjectReference.Local(filter["m_GameObject"]);
                if (mesh is not { } target || owner == 0 || !tables.IsClass(member.Name, owner, 1)) continue;
                if (!filters.TryGetValue(owner, out var meshes)) filters.Add(owner, meshes = []);
                meshes.Add(target);
            }
            catch (Exception error) when (error is not OutOfMemoryException) { }
        }
        if (filters.Count == 0) return;
        foreach (var info in objects.Values)
        {
            if (info.GetTypeId(member.File) != 23 || info.ByteSize > 2L << 20) continue;
            HashSet<ObjectAddress>? ownerMeshes = null;
            try
            {
                var renderer = member.ReadField(info);
                var owner = ObjectReference.Local(renderer["m_GameObject"]);
                if (!filters.TryGetValue(owner, out ownerMeshes)) continue;
                var materials = renderer["m_Materials.Array"];
                var binding = ownerMeshes.Count != 1 || materials.IsDummy || materials.Children.Count > 128
                    ? new MeshBindings("unresolved")
                    : new MeshBindings("linked", materials.Children.Select(field => tables.ReadReference(member, field)).ToArray(),
                        member.Name);
                foreach (var mesh in ownerMeshes) Merge(mesh, binding);
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                if (ownerMeshes != null)
                    foreach (var mesh in ownerMeshes) Merge(mesh, new MeshBindings("unresolved"));
            }
        }
        void Merge(ObjectAddress mesh, MeshBindings binding)
        {
            if (binding.RendererMember == mesh.Member) binding = binding with { RendererMember = null };
            if (!result.TryGetValue(mesh, out var current)) result.Add(mesh, binding);
            else if (!SameSlots(mesh.Member, current, binding))
                result[mesh] = new MeshBindings("ambiguous");
        }
    }

    private static bool SameSlots(string meshMember, MeshBindings left, MeshBindings right)
    {
        if (left.Slots == null || right.Slots == null || left.Slots.Length != right.Slots.Length) return false;
        var leftSource = left.RendererMember ?? meshMember;
        var rightSource = right.RendererMember ?? meshMember;
        for (var index = 0; index < left.Slots.Length; index++)
        {
            var a = left.Slots[index];
            var b = right.Slots[index];
            if (a == null && b == null) continue;
            if (a == null || b == null || a.PathId != b.PathId) return false;
            var target = a.TargetMember ?? (a.FileId == 0 ? leftSource : null);
            var other = b.TargetMember ?? (b.FileId == 0 ? rightSource : null);
            if (target != other || (target == null && (leftSource != rightSource || a.FileId != b.FileId))) return false;
        }
        return true;
    }
}
