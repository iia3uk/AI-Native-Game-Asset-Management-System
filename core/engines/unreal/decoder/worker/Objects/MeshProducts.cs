using System.Text.Json.Serialization;

namespace AssetViewer.UnrealDecode.Objects;

internal sealed record MeshSection(int Slot, int FirstIndex, int Triangles, string? Name, string? Material, bool Collision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] int BaseVertex = 0,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] int VertexCount = 0);
internal sealed record MeshLod(int Lod, int Vertices, int Uvs, bool Colors, int Indices, long Size, bool TangentsQuantized, MeshSection[] Sections,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] int Influences = 0);
internal sealed record MeshExport(MeshLod[] Lods, int[] Missing, bool Limited,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] int BoneCount = 0);
