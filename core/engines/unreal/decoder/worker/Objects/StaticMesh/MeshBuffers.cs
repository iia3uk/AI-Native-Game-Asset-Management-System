using CUE4Parse.UE4.Assets.Exports.StaticMesh;

namespace AssetViewer.UnrealDecode.Objects;

internal static class MeshBuffers
{
    public static MeshLod? Describe(FStaticMeshLODResources lod, int level, Func<int, (string?, string?)> material)
    {
        if (lod.SkipLod || lod.PositionVertexBuffer?.Verts is not { Length: >= 3 and <= 1_000_000 } positions ||
            lod.VertexBuffer is not { NumTexCoords: >= 1 and <= 8 } vertex || vertex.UV.Length != positions.Length ||
            lod.IndexBuffer?.Buffer is not { Length: >= 3 and <= 3_000_000 } indices ||
            lod.Sections.Length is < 1 or > 128) return null;

        var colors = lod.ColorVertexBuffer?.Data.Length ?? 0;
        if (colors != 0 && colors != positions.Length) return null;
        var bytesPerVertex = 40 + 8 * vertex.NumTexCoords + (colors == 0 ? 0 : 4);
        var size = (long)positions.Length * bytesPerVertex + (long)indices.Length * 4;
        if (size > 96 * 1024 * 1024) return null;

        if (indices.Any(index => index >= positions.Length) || positions.Any(point =>
            !float.IsFinite(point.X) || !float.IsFinite(point.Y) || !float.IsFinite(point.Z)) ||
            vertex.UV.Any(row => row.Normal.Length != 3 || row.UV.Length != vertex.NumTexCoords ||
                row.UV.Any(uv => !float.IsFinite(uv.U) || !float.IsFinite(uv.V)))) return null;

        var sections = new List<MeshSection>();
        var ranges = new List<(int Start, int End)>();
        foreach (var section in lod.Sections)
        {
            if (section.NumTriangles == 0) continue;
            var end = section.FirstIndex + 3L * section.NumTriangles;
            if (section.MaterialIndex is < 0 or > 127 || section.FirstIndex < 0 || section.FirstIndex % 3 != 0 ||
                section.NumTriangles < 1 || end > indices.Length) return null;
            if (ranges.Any(range => section.FirstIndex < range.End && range.Start < end)) return null;
            ranges.Add((section.FirstIndex, (int)end));
            var (name, path) = material(section.MaterialIndex);
            sections.Add(new MeshSection(section.MaterialIndex, section.FirstIndex, section.NumTriangles, name, path, section.bEnableCollision));
        }
        return sections.Count == 0 ? null : new MeshLod(level, positions.Length, vertex.NumTexCoords,
            colors != 0, indices.Length, size, vertex.UseHighPrecisionTangentBasis, sections.ToArray());
    }

    public static void Write(FStaticMeshLODResources lod, MeshLod product, Stream output)
    {
        using var writer = new BinaryWriter(output, System.Text.Encoding.UTF8, leaveOpen: true);
        var points = lod.PositionVertexBuffer!.Verts;
        var vertices = lod.VertexBuffer!.UV;
        for (var i = 0; i < points.Length; i++)
        {
            var point = points[i];
            writer.Write(point.X);
            writer.Write(point.Y);
            writer.Write(point.Z);
            var tangent = vertices[i].Normal[0];
            var normal = vertices[i].Normal[2];
            writer.Write(normal.X);
            writer.Write(normal.Y);
            writer.Write(normal.Z);
            writer.Write(tangent.X);
            writer.Write(tangent.Y);
            writer.Write(tangent.Z);
            writer.Write(normal.W < 0 ? -1f : 1f);
            foreach (var uv in vertices[i].UV)
            {
                writer.Write(uv.U);
                writer.Write(uv.V);
            }
            if (!product.Colors) continue;
            var color = lod.ColorVertexBuffer!.Data[i];
            writer.Write(color.R);
            writer.Write(color.G);
            writer.Write(color.B);
            writer.Write(color.A);
        }
        foreach (var index in lod.IndexBuffer!.Buffer!) writer.Write(index);
    }
}
