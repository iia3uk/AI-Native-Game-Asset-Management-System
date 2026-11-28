using System.Text.Json;
using AssetViewer.UnityBundle.Objects.Mesh;

namespace AssetViewer.UnityBundle.Formats;

internal static class Glb
{
    public static byte[] Write(StaticMesh mesh)
    {
        using var buffer = new MemoryStream();
        using var binary = new BinaryWriter(buffer);
        var views = new List<object>();
        var accessors = new List<object>();
        var attributes = new Dictionary<string, int>();
        var primitives = new List<object>();

        foreach (var (semantic, values) in mesh.Vertices.Attributes)
        {
            var start = (int)buffer.Position;
            foreach (var value in values) binary.Write(value);
            views.Add(new { buffer = 0, byteOffset = start, byteLength = (int)buffer.Position - start, target = 34962 });
            attributes.Add(semantic, accessors.Count);
            var entry = new Dictionary<string, object>
            {
                ["bufferView"] = views.Count - 1, ["componentType"] = 5126, ["count"] = mesh.Vertices.Count,
                ["type"] = semantic switch { "TEXCOORD_0" => "VEC2", "TANGENT" => "VEC4", _ => "VEC3" },
            };
            if (semantic == "POSITION")
            {
                var min = new[] { float.MaxValue, float.MaxValue, float.MaxValue };
                var max = new[] { float.MinValue, float.MinValue, float.MinValue };
                for (int offset = 0; offset < values.Length; offset++)
                {
                    int axis = offset % 3;
                    min[axis] = Math.Min(min[axis], values[offset]);
                    max[axis] = Math.Max(max[axis], values[offset]);
                }
                entry["min"] = min;
                entry["max"] = max;
            }
            accessors.Add(entry);
        }

        foreach (var group in mesh.Groups)
        {
            var start = (int)buffer.Position;
            foreach (var index in group) binary.Write(index);
            views.Add(new { buffer = 0, byteOffset = start, byteLength = (int)buffer.Position - start, target = 34963 });
            primitives.Add(new { attributes, indices = accessors.Count, mode = 4 });
            accessors.Add(new { bufferView = views.Count - 1, componentType = 5125, count = group.Length, type = "SCALAR" });
        }
        var json = JsonSerializer.SerializeToUtf8Bytes(new
        {
            asset = new { version = "2.0", generator = "Asset Viewer UnityFS" },
            scene = 0,
            scenes = new[] { new { nodes = new[] { 0 } } },
            nodes = new[] { new { name = mesh.Name, mesh = 0 } },
            meshes = new[] { new { name = mesh.Name, primitives } },
            buffers = new[] { new { byteLength = (int)buffer.Length } },
            bufferViews = views,
            accessors,
        });
        var padded = (json.Length + 3) & ~3;
        using var glb = new MemoryStream((int)buffer.Length + padded + 28);
        using var writer = new BinaryWriter(glb);
        writer.Write(0x46546c67);
        writer.Write(2);
        writer.Write((int)buffer.Length + padded + 28);
        writer.Write(padded);
        writer.Write(0x4e4f534a);
        writer.Write(json);
        for (int index = json.Length; index < padded; index++) writer.Write((byte)0x20);
        writer.Write((int)buffer.Length);
        writer.Write(0x004e4942);
        buffer.WriteTo(glb);
        return glb.ToArray();
    }
}
