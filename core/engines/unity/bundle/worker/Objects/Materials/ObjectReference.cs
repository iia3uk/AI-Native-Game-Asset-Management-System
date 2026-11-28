using System.Globalization;
using System.Text.Json.Serialization;
using AssetsTools.NET;

namespace AssetViewer.UnityBundle.Objects.Materials;

internal sealed record ObjectReference(int FileId, string PathId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TargetMember = null)
{
    public static ObjectReference? Read(AssetTypeValueField field)
    {
        var fileId = field["m_FileID"];
        var pathId = field["m_PathID"];
        if (fileId.IsDummy || pathId.IsDummy || fileId.AsInt < 0)
            throw new BundleException("unity-bundle-material-reference");
        return pathId.AsLong == 0 ? null : new ObjectReference(fileId.AsInt,
            pathId.AsLong.ToString(CultureInfo.InvariantCulture));
    }

    public static long Local(AssetTypeValueField field) =>
        !field["m_FileID"].IsDummy && field["m_FileID"].AsInt == 0 && !field["m_PathID"].IsDummy
            ? field["m_PathID"].AsLong : 0;
}
