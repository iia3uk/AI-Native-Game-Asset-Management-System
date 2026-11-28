using AssetsTools.NET;

namespace AssetViewer.UnityBundle.Objects.Materials;

internal sealed record MeshBindings(string Status, ObjectReference?[]? Slots = null);

internal static class MeshMaterialSlots
{
    public static Dictionary<long, MeshBindings> Read(Dictionary<long, AssetFileInfo> objects, AssetsFile file,
        Func<long, int, AssetTypeValueField> readLocal)
    {
        var filters = new Dictionary<long, HashSet<long>>();
        foreach (var (id, info) in objects)
        {
            if (info.GetTypeId(file) != 33) continue;
            try
            {
                var filter = readLocal(id, 33);
                var mesh = ObjectReference.Local(filter["m_Mesh"]);
                var owner = ObjectReference.Local(filter["m_GameObject"]);
                if (mesh == 0 || owner == 0 || !IsClass(mesh, 43) || !IsClass(owner, 1)) continue;
                if (!filters.TryGetValue(owner, out var meshes)) filters.Add(owner, meshes = []);
                meshes.Add(mesh);
            }
            catch (Exception error) when (error is not OutOfMemoryException) { }
        }
        var result = new Dictionary<long, MeshBindings>();
        if (filters.Count == 0) return result;
        foreach (var (id, info) in objects)
        {
            if (info.GetTypeId(file) != 23) continue;
            var ownerMeshes = (HashSet<long>?)null;
            try
            {
                var renderer = readLocal(id, 23);
                var owner = ObjectReference.Local(renderer["m_GameObject"]);
                if (!filters.TryGetValue(owner, out ownerMeshes)) continue;
                var materials = renderer["m_Materials.Array"];
                var binding = ownerMeshes.Count != 1 || materials.IsDummy || materials.Children.Count > 128
                    ? new MeshBindings("unresolved")
                    : new MeshBindings("linked", materials.Children.Select(ObjectReference.Read).ToArray());
                foreach (var mesh in ownerMeshes) Merge(mesh, binding);
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                if (ownerMeshes != null)
                    foreach (var mesh in ownerMeshes) Merge(mesh, new MeshBindings("unresolved"));
            }
        }
        return result;

        bool IsClass(long id, int type) => objects.TryGetValue(id, out var info) && info.GetTypeId(file) == type;

        void Merge(long mesh, MeshBindings binding)
        {
            if (!result.TryGetValue(mesh, out var current)) result.Add(mesh, binding);
            else if (current.Slots == null || binding.Slots == null || !current.Slots.SequenceEqual(binding.Slots))
                result[mesh] = new MeshBindings("ambiguous");
        }
    }
}
