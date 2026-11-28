using AssetViewer.UnityBundle.Objects.Materials;
using AssetViewer.UnityBundle.Serialized;

namespace AssetViewer.UnityBundle.UnityFs;

internal static class BundleObjects
{
    public static Report Read(bool inspectOnly, long outputLimit, int dependencyCount)
    {
        using var primary = new BundleArchive(0, "input.bundle");
        var candidates = new List<BundleArchive>();
        try
        {
            var inputBytes = primary.InputBytes;
            for (var index = 1; index <= dependencyCount; index++)
            {
                var candidate = OpenDependency(index, primary.Header.Version, Header.InputLimit - inputBytes);
                if (candidate == null) continue;
                inputBytes += candidate.InputBytes;
                candidates.Add(candidate);
            }
            var archives = candidates.Prepend(primary).ToDictionary(archive => archive.Index);
            var members = MountedMembers(primary, candidates);
            var entries = new List<Asset>();
            var materialBudget = 8192;
            var tables = new ObjectTables(members);
            var bindings = new Dictionary<ObjectAddress, MeshBindings>();
            foreach (var member in members) MeshMaterialSlots.Read(member, tables, bindings);
            foreach (var member in members)
                SerializedObjects.Read(member, tables, bindings, archives[member.Archive].Resources, inspectOnly,
                    entries, ref outputLimit, ref materialBudget);
            return new Report(1, Program.DecoderRevision, "completed", primary.Header.Format, primary.Header.Version, entries);
        }
        finally
        {
            foreach (var candidate in candidates) candidate.Dispose();
        }
    }

    private static BundleArchive? OpenDependency(int index, string version, long budget)
    {
        try
        {
            var archive = new BundleArchive(index, $"dependency-{index}.bundle", budget);
            if (archive.Header.Version == version) return archive;
            archive.Dispose();
        }
        catch (Exception error) when (error is not OutOfMemoryException) { }
        return null;
    }

    private static List<SerializedMember> MountedMembers(BundleArchive primary, IReadOnlyList<BundleArchive> candidates)
    {
        var duplicateNames = candidates.Prepend(primary).SelectMany(archive => archive.Names)
            .GroupBy(name => name, StringComparer.OrdinalIgnoreCase).Where(group => group.Count() > 1)
            .Select(group => group.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var available = new Dictionary<string, BundleArchive>(StringComparer.OrdinalIgnoreCase);
        foreach (var archive in candidates.Where(archive => !archive.Names.Any(duplicateNames.Contains)))
            foreach (var name in archive.Names) available.Add(name, archive);

        var remainingObjects = 10000;
        var members = primary.ReadMembers(remainingObjects);
        remainingObjects -= members.Sum(member => member.File.AssetInfos.Count);
        var unpacked = primary.UnpackedBytes;
        var visited = new HashSet<int>();
        for (var index = 0; index < members.Count; index++)
        {
            foreach (var fileId in ExternalMaterials.FileIds(members[index]))
            {
                var external = members[index].File.Metadata.Externals[fileId - 1];
                if (MemberPath.Read(external.PathName) is not { Mount: { } mount } path ||
                    !available.TryGetValue(mount, out var anchor) || !available.TryGetValue(path.Name, out var target) ||
                    anchor != target || !visited.Add(target.Index) || target.UnpackedBytes > (256L << 20) - unpacked) continue;
                try
                {
                    var next = target.ReadMembers(remainingObjects);
                    members.AddRange(next);
                    remainingObjects -= next.Sum(member => member.File.AssetInfos.Count);
                    unpacked += target.UnpackedBytes;
                }
                catch (Exception error) when (error is not OutOfMemoryException) { }
            }
        }
        return members;
    }
}
