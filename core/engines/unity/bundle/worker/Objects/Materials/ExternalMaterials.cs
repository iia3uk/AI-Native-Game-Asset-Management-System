using AssetsTools.NET;
using AssetViewer.UnityBundle.Serialized;

namespace AssetViewer.UnityBundle.Objects.Materials;

internal static class ExternalMaterials
{
    public static IEnumerable<int> FileIds(SerializedMember member)
    {
        var ids = new HashSet<int>();
        if (!member.File.Metadata.TypeTreeEnabled || member.File.Metadata.Externals.Count == 0) return ids;
        foreach (var info in member.File.AssetInfos)
        {
            var classId = info.GetTypeId(member.File);
            if (classId is not (21 or 23 or 33) || info.ByteSize > 2L << 20) continue;
            try
            {
                var field = member.ReadField(info);
                switch (classId)
                {
                    case 21:
                        Add(field["m_Shader"]);
                        var textures = field["m_SavedProperties.m_TexEnvs.Array"];
                        if (textures.Children.Count <= 64)
                            foreach (var texture in textures.Children) Add(texture["second.m_Texture"]);
                        break;
                    case 23:
                        var materials = field["m_Materials.Array"];
                        if (materials.Children.Count <= 128)
                            foreach (var material in materials.Children) Add(material);
                        break;
                    case 33:
                        Add(field["m_Mesh"]);
                        break;
                }
            }
            catch (Exception error) when (error is not OutOfMemoryException) { }
        }
        return ids.Order();

        void Add(AssetTypeValueField field)
        {
            if (ObjectReference.Read(field) is { FileId: > 0 } reference &&
                reference.FileId <= member.File.Metadata.Externals.Count)
                ids.Add(reference.FileId);
        }
    }
}
