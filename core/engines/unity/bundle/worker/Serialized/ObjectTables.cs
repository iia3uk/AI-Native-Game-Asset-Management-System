using System.Globalization;
using AssetsTools.NET;
using AssetViewer.UnityBundle.Objects.Materials;

namespace AssetViewer.UnityBundle.Serialized;

internal readonly record struct ObjectAddress(string Member, long PathId);

internal sealed class ObjectTables
{
    private readonly Dictionary<string, SerializedMember> members;
    private readonly Dictionary<string, Dictionary<long, AssetFileInfo>> tables = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<ObjectAddress, bool> standardShaders = [];

    public ObjectTables(IReadOnlyList<SerializedMember> inputs)
    {
        members = inputs.ToDictionary(member => member.Name, StringComparer.OrdinalIgnoreCase);
        var remaining = 10000;
        foreach (var member in inputs)
        {
            var table = member.ReadTable(remaining);
            tables.Add(member.Name, table);
            remaining -= table.Count;
        }
    }

    public Dictionary<long, AssetFileInfo> In(SerializedMember member) => tables[member.Name];

    private static string? ExternalPath(SerializedMember member, int fileId) =>
        fileId > 0 && fileId <= member.File.Metadata.Externals.Count
            ? member.File.Metadata.Externals[fileId - 1].PathName
            : null;

    public ObjectReference? ReadReference(SerializedMember member, AssetTypeValueField field)
    {
        var reference = ObjectReference.Read(field);
        if (reference is not { FileId: > 0 } || MemberPath.Read(ExternalPath(member, reference.FileId)) is not { } path ||
            !members.TryGetValue(path.Name, out var target) || In(target).Count == 0)
            return reference;
        var correctMount = path.Mount == null ? member.Archive == target.Archive :
            members.TryGetValue(path.Mount, out var anchor) && anchor.Archive == target.Archive;
        return correctMount ? reference with { TargetMember = target.Name } : reference;
    }

    public ObjectAddress? Address(SerializedMember source, ObjectReference? reference, int classId)
    {
        if (reference == null) return null;
        var name = reference.TargetMember ?? (reference.FileId == 0 ? source.Name : null);
        if (name == null) return null;
        var id = long.Parse(reference.PathId, CultureInfo.InvariantCulture);
        return IsClass(name, id, classId) ? new ObjectAddress(name, id) : null;
    }

    public bool IsClass(string name, long id, int classId) =>
        tables[name].TryGetValue(id, out var info) && info.GetTypeId(members[name].File) == classId;

    public bool IsStandard(SerializedMember source, ObjectReference reference)
    {
        var address = Address(source, reference, 48);
        if (address is not { } key)
            return reference is { TargetMember: null, PathId: "46" } &&
                ExternalPath(source, reference.FileId)?.ToLowerInvariant() is
                    "resources/unity_builtin_extra" or "library/unity default resources" or "resources/unity default resources";
        if (standardShaders.TryGetValue(key, out var standard)) return standard;
        var target = members[key.Member];
        var info = In(target)[key.PathId];
        try
        {
            standard = target.File.Metadata.TypeTreeEnabled && info.ByteSize <= 2L << 20 &&
                target.ReadField(info)["m_ParsedForm.m_Name"].AsString == "Standard";
        }
        catch (Exception error) when (error is not OutOfMemoryException) { standard = false; }
        return standardShaders[key] = standard;
    }
}
