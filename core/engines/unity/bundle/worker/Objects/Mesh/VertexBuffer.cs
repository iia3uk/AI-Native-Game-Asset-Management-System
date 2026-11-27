using System.Buffers.Binary;
using AssetsTools.NET;

namespace AssetViewer.UnityBundle.Objects.Mesh;

internal sealed record VertexBuffer(int Count, Dictionary<string, float[]> Attributes)
{
    public static VertexBuffer Read(AssetTypeValueField vertexData)
    {
        var count = vertexData["m_VertexCount"].AsUInt;
        if (count is < 3 or > 200000) throw new BundleException("unity-bundle-mesh-vertex-limit");
        var bytes = vertexData["m_DataSize"].AsByteArray;
        var channels = vertexData["m_Channels.Array"].Children;
        var layout = new List<(string Semantic, int Dimension, int Offset)>();
        int stride = 0;
        foreach (var (channel, index) in channels.Select((channel, index) => (channel, index)))
        {
            var dimension = channel["dimension"].AsByte;
            if (dimension == 0) continue;
            if (channel["stream"].AsByte != 0 || channel["format"].AsByte != 0)
                throw new BundleException("unity-bundle-mesh-vertex-layout");
            var (semantic, expectedDimension) = index switch
            {
                0 => ("POSITION", 3),
                1 => ("NORMAL", 3),
                4 => ("TEXCOORD_0", 2),
                _ => ("", 0),
            };
            var offset = channel["offset"].AsByte;
            if (dimension != expectedDimension || offset != stride)
                throw new BundleException("unity-bundle-mesh-vertex-layout");
            layout.Add((semantic, dimension, offset));
            stride += dimension * 4;
        }
        var required = stride * (int)count;
        if (layout.Count == 0 || layout[0].Semantic != "POSITION" || bytes.Length < required || bytes.Length > required + 15)
            throw new BundleException("unity-bundle-mesh-vertex-layout");

        var attributes = new Dictionary<string, float[]>();
        foreach (var (semantic, dimension, offset) in layout)
        {
            var values = new float[count * dimension];
            for (int vertex = 0; vertex < count; vertex++)
            {
                var start = vertex * stride + offset;
                var position = vertex * dimension;
                for (int axis = 0; axis < dimension; axis++)
                {
                    var value = BinaryPrimitives.ReadSingleLittleEndian(bytes.AsSpan(start + axis * 4, 4));
                    if (!float.IsFinite(value) || MathF.Abs(value) > 1e8f)
                        throw new BundleException("unity-bundle-mesh-vertex-value");
                    values[position + axis] = value;
                }
                if (semantic == "TEXCOORD_0")
                {
                    values[position + 1] = 1 - values[position + 1];
                    continue;
                }
                values[position + 2] = -values[position + 2];
                if (semantic != "NORMAL") continue;
                var vector = values.AsSpan(position, 3);
                var length = MathF.Sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
                if (length < 1e-6f) throw new BundleException("unity-bundle-mesh-normal");
                for (int axis = 0; axis < 3; axis++) vector[axis] /= length;
            }
            attributes.Add(semantic, values);
        }
        return new VertexBuffer((int)count, attributes);
    }
}
