using System.Buffers.Binary;
using AssetsTools.NET;

namespace AssetViewer.UnityBundle.Objects.Mesh;

internal static class TriangleGroups
{
    public static IReadOnlyList<uint[]> Read(AssetTypeValueField mesh, int vertices)
    {
        var step = mesh["m_IndexFormat"].AsInt switch
        {
            0 => 2,
            1 => 4,
            _ => throw new BundleException("unity-bundle-mesh-index-format"),
        };
        var groups = mesh["m_SubMeshes.Array"].Children;
        if (groups.Count is < 1 or > 128) throw new BundleException("unity-bundle-mesh-submesh-limit");
        var bytes = mesh["m_IndexBuffer.Array"].AsByteArray;
        var result = new List<uint[]>(groups.Count);
        uint total = 0;
        foreach (var group in groups)
        {
            var count = group["indexCount"].AsUInt;
            var offset = group["firstByte"].AsUInt;
            var baseVertex = group["baseVertex"].AsUInt;
            if (group["topology"].AsInt != 0 || count == 0 || count % 3 != 0 || count > 600000 - total ||
                offset % step != 0 || offset > bytes.Length || count * step > bytes.Length - offset)
                throw new BundleException("unity-bundle-mesh-index-range");

            var indices = new uint[count];
            for (int index = 0; index < indices.Length; index += 3)
            {
                var start = (int)offset + index * step;
                indices[index] = ReadIndex(bytes, start, step, baseVertex, vertices);
                indices[index + 1] = ReadIndex(bytes, start + 2 * step, step, baseVertex, vertices);
                indices[index + 2] = ReadIndex(bytes, start + step, step, baseVertex, vertices);
            }
            total += count;
            result.Add(indices);
        }
        return result;
    }

    private static uint ReadIndex(byte[] bytes, int start, int step, uint baseVertex, int vertices)
    {
        var index = step == 2
            ? BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(start, step))
            : BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(start, step));
        if ((ulong)index + baseVertex >= (ulong)vertices) throw new BundleException("unity-bundle-mesh-index-range");
        return index + baseVertex;
    }
}
