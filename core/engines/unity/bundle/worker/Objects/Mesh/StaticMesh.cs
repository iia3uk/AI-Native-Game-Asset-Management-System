using AssetsTools.NET;
using AssetViewer.UnityBundle.Formats;

namespace AssetViewer.UnityBundle.Objects.Mesh;

internal sealed record StaticMesh(string Name, VertexBuffer Vertices, IReadOnlyList<uint[]> Groups)
{
    public static StaticMesh Read(AssetTypeValueField field)
    {
        if (field["m_MeshCompression"].AsByte != 0 || field["m_BindPose.Array"].Children.Count != 0 ||
            field["m_BoneNameHashes.Array"].Children.Count != 0 ||
            field["m_Shapes.vertices.Array"].Children.Count != 0)
            throw new BundleException("unity-bundle-mesh-complex");
        var vertices = VertexBuffer.Read(field["m_VertexData"]);
        var triangles = TriangleGroups.Read(field, vertices.Count);
        var name = field["m_Name"].AsString;
        return new StaticMesh(name.Length > 160 ? name[..160] : name, vertices, triangles);
    }

    public Product ToProduct(bool inspectOnly) => new(Name, "glb",
        inspectOnly ? [] : Glb.Write(this), Vertices: Vertices.Count, Triangles: Groups.Sum(group => group.Length) / 3);
}
