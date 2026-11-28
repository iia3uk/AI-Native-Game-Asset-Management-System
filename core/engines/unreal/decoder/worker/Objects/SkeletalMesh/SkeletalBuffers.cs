using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Objects.Core.Math;

namespace AssetViewer.UnrealDecode.Objects;

internal sealed class SkeletalBuffers(MeshLod product, FGPUVertFloat[] points, FColor[] colors, uint[] indices, FSkelMeshSection?[] owners)
{
    public MeshLod Product { get; } = product;

    public static SkeletalBuffers? Read(FStaticLODModel lod, int level, int bones, Func<int, (string?, string?)> material)
    {
        if (lod.VertexBufferGPUSkin?.VertsFloat is not { Length: >= 3 and <= 1_000_000 } points ||
            lod.NumTexCoords is < 1 or > 8 || lod.Indices?.Buffer is not { Length: >= 3 and <= 3_000_000 } indices ||
            lod.Sections.Length is < 1 or > 128) return null;
        var colors = lod.ColorVertexBuffer.Data;
        if (colors.Length != 0 && colors.Length != points.Length) return null;
        var owners = new FSkelMeshSection?[points.Length];
        var sections = new List<MeshSection>();
        var influences = 4;
        foreach (var section in lod.Sections)
        {
            if (section.bDisabled || section.NumTriangles == 0) continue;
            var start = (int)section.BaseVertexIndex;
            var end = (long)section.BaseVertexIndex + section.NumVertices;
            var first = section.BaseIndex;
            var limit = first + 3L * section.NumTriangles;
            var palette = section.BoneMap;
            if (section.MaterialIndex is < 0 or > 127 || section.NumTriangles < 0 || first < 0 || first % 3 != 0 ||
                limit > indices.Length || section.NumVertices < 3 || end > points.Length ||
                section.MaxBoneInfluences is < 1 or > 12 || palette.Length == 0 || palette.Length > bones ||
                palette.Any(bone => bone >= bones) || palette.Distinct().Count() != palette.Length) return null;
            if (sections.Any(other => first < other.FirstIndex + 3L * other.Triangles && other.FirstIndex < limit)) return null;
            for (var n = first; n < limit; n++) if (indices[n] < start || indices[n] >= end) return null;
            for (var i = start; i < end; i++)
            {
                if (owners[i] != null) return null;
                owners[i] = section;
                var count = WeightCount(points[i].Infs, section);
                if (count == 0 || count > 8) return null;
                if (count > 4) influences = 8;
            }
            var (name, path) = material(section.MaterialIndex);
            sections.Add(new MeshSection(section.MaterialIndex, first, section.NumTriangles, name, path, false, start, section.NumVertices));
        }
        var size = points.Length * (40L + 8 * lod.NumTexCoords + (colors.Length > 0 ? 4 : 0) + 3 * influences) + 4L * indices.Length;
        if (sections.Count == 0 || size > 96 * 1024 * 1024 || points.Any(point =>
            !float.IsFinite(point.Pos.X) || !float.IsFinite(point.Pos.Y) || !float.IsFinite(point.Pos.Z) ||
            point.Normal.Length != 3 || point.UVs.Length != lod.NumTexCoords ||
            point.UVs.Any(uv => !float.IsFinite(uv.U) || !float.IsFinite(uv.V)))) return null;
        return new(new MeshLod(level, points.Length, lod.NumTexCoords, colors.Length > 0, indices.Length,
            size, true, sections.ToArray(), influences), points, colors, indices, owners);
    }

    private static int WeightCount(FSkinWeightInfo? skin, FSkelMeshSection section)
    {
        if (skin == null || skin.bUse16BitBoneWeight || skin.BoneIndex.Length != skin.BoneWeight.Length ||
            skin.BoneWeight.Length is < 1 or > 12) return 0;
        var sum = 0;
        var used = 0;
        Span<ushort> seen = stackalloc ushort[12];
        for (var i = 0; i < skin.BoneWeight.Length; i++)
        {
            var weight = skin.BoneWeight[i];
            if (weight == 0) continue;
            var local = skin.BoneIndex[i];
            if (weight > 255 || local >= section.BoneMap.Length || seen[..used].Contains(local)) return 0;
            seen[used++] = local;
            sum += weight;
        }
        return sum == 255 && used <= section.MaxBoneInfluences ? used : 0;
    }

    public void Write(Stream output)
    {
        using var writer = new BinaryWriter(output, System.Text.Encoding.UTF8, leaveOpen: true);
        for (var index = 0; index < points.Length; index++)
        {
            var point = points[index];
            writer.Write(point.Pos.X);
            writer.Write(point.Pos.Y);
            writer.Write(point.Pos.Z);
            var normal = point.Normal[2];
            var tangent = point.Normal[0];
            writer.Write(normal.X);
            writer.Write(normal.Y);
            writer.Write(normal.Z);
            writer.Write(tangent.X);
            writer.Write(tangent.Y);
            writer.Write(tangent.Z);
            writer.Write(normal.W < 0 ? -1f : 1f);
            foreach (var uv in point.UVs)
            {
                writer.Write(uv.U);
                writer.Write(uv.V);
            }
            if (Product.Colors)
            {
                var color = colors[index];
                writer.Write(color.R);
                writer.Write(color.G);
                writer.Write(color.B);
                writer.Write(color.A);
            }
            var used = 0;
            if (owners[index] is { } section && point.Infs is { } skin)
            {
                for (var slot = 0; slot < skin.BoneWeight.Length; slot++)
                {
                    if (skin.BoneWeight[slot] == 0) continue;
                    writer.Write(section.BoneMap[skin.BoneIndex[slot]]);
                    writer.Write((byte)skin.BoneWeight[slot]);
                    used++;
                }
            }
            for (; used < Product.Influences; used++)
            {
                writer.Write((ushort)0);
                writer.Write((byte)0);
            }
        }
        foreach (var index in indices) writer.Write(index);
    }
}
