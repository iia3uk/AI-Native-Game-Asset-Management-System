using AssetViewer.UnrealDecode.Objects;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Readers;

namespace AssetViewer.UnrealDecode.IoStore.Zen.Collision;

internal sealed record CollisionField(FPropertyTag Tag, long Start)
{
    public long End => Start + Tag.Size;
}

internal sealed class CollisionProperties(FAssetArchive archive, Dictionary<string, CollisionField> fields)
{
    public const double MaximumComponent = 1e8;
    public IEnumerable<KeyValuePair<string, CollisionField>> Fields => fields;

    public static CollisionProperties Read(FAssetArchive archive, long end, bool root = false)
    {
        var rows = new Dictionary<string, CollisionField>(StringComparer.Ordinal);
        void Visit(FPropertyTag tag)
        {
            if (tag.ArrayIndex == 0 && !rows.TryAdd(tag.Name.Text, new(tag, archive.Position)))
                throw ZenPackage.Invalid();
        }
        if (root) TaggedProperties.Read(archive, Visit);
        else TaggedProperties.ReadTags(archive, end, Visit);
        return new(archive, rows);
    }

    private FPropertyTag Field(CollisionField field, string type)
    {
        if (field.Tag.PropertyType.Text != type || field.Tag.SerializeType == EPropertyTagSerializeType.Skipped)
            throw ZenPackage.Invalid();
        archive.Position = field.Start;
        return field.Tag;
    }

    public CollisionProperties? Struct(string name, string type)
    {
        if (!fields.TryGetValue(name, out var field)) return null;
        var tag = Field(field, "StructProperty");
        if (tag.TagData?.StructType != type || tag.SerializeType != EPropertyTagSerializeType.Property)
            throw ZenPackage.Invalid();
        var result = Read(archive, field.End);
        if (archive.Position != field.End) throw ZenPackage.Invalid();
        return result;
    }

    public double[] Vector(string name, string type, double[] defaults)
    {
        if (!fields.TryGetValue(name, out var field)) return defaults;
        if (Field(field, "StructProperty").TagData?.StructType != type || field.Tag.Size != 8 * defaults.Length)
            throw ZenPackage.Invalid();
        return Components(defaults.Length, archive.Read<double>);
    }

    public ZenCollisionTransform Transform()
    {
        if (!fields.TryGetValue("Transform", out var field)) return new([0, 0, 0, 1], [0, 0, 0], [1, 1, 1]);
        var tag = Field(field, "StructProperty");
        if (tag.TagData?.StructType != "Transform") throw ZenPackage.Invalid();
        if (tag.SerializeType == EPropertyTagSerializeType.BinaryOrNative)
        {
            if (tag.Size != 80) throw ZenPackage.Invalid();
            return new(Components(4, archive.Read<double>), Components(3, archive.Read<double>), Components(3, archive.Read<double>));
        }
        var transform = Struct("Transform", "Transform")!;
        return new(transform.Vector("Rotation", "Quat", [0, 0, 0, 1]), transform.Vector("Translation", "Vector", [0, 0, 0]),
            transform.Vector("Scale3D", "Vector", [1, 1, 1]));
    }

    public double Scalar(string name, double minimum, double? fallback = null)
    {
        if (!fields.TryGetValue(name, out var field)) return fallback ?? throw ZenPackage.Invalid();
        if (Field(field, "FloatProperty").Size != 4) throw ZenPackage.Invalid();
        var value = archive.Read<float>();
        return value >= minimum && value <= MaximumComponent ? value : throw ZenPackage.Invalid();
    }

    public bool? Bool(string name) => fields.TryGetValue(name, out var field) ? TaggedProperties.TaggedBoolean(field.Tag) : null;

    public string? Name(string name, string? enumType = null)
    {
        if (!fields.TryGetValue(name, out var field)) return null;
        var type = enumType == null ? "NameProperty" : field.Tag.PropertyType.Text;
        if (enumType != null && type is not ("ByteProperty" or "EnumProperty")) throw ZenPackage.Invalid();
        var tag = Field(field, type);
        if (tag.Size != 8 || (enumType != null && tag.TagData?.EnumName != enumType &&
            tag.TagData?.EnumName != enumType + "::Type")) throw ZenPackage.Invalid();
        var text = archive.ReadFName().Text;
        var parts = enumType == null ? [text] : text.Split("::");
        if (text.Length > 256 || parts.Length > 2 || !parts.All(ZenImports.ValidObject)) throw ZenPackage.Invalid();
        return text;
    }

    public (int Count, long End) StructArray(CollisionField field, string type, int limit)
    {
        return TaggedProperties.StructArrayRange(archive, Field(field, "ArrayProperty"), type, limit);
    }

    public double[][] Vertices()
    {
        if (!fields.TryGetValue("VertexData", out var field)) throw ZenPackage.Invalid();
        var (count, end) = StructArray(field, "Vector", 256);
        if (count < 4 || archive.Position + count * 24 != end) throw ZenPackage.Invalid();
        var vertices = new double[count][];
        for (var i = 0; i < count; i++) vertices[i] = Components(3, archive.Read<double>);
        return vertices;
    }

    public int[]? Indices(int vertexCount)
    {
        if (!fields.TryGetValue("IndexData", out var field)) return null;
        var tag = Field(field, "ArrayProperty");
        if (tag.TagData?.InnerType != "IntProperty" || tag.Size < 4) throw ZenPackage.Invalid();
        var count = archive.Read<int>();
        if (count == 0 && tag.Size == 4) return null;
        if (count is < 12 or > 1536 || count % 3 != 0 || tag.Size != 4 + count * 4) throw ZenPackage.Invalid();
        var indices = archive.ReadArray<int>(count);
        if (indices.Any(index => index < 0 || index >= vertexCount)) throw ZenPackage.Invalid();
        return indices;
    }

    public bool HasElements(CollisionField field)
    {
        if (field.Tag.PropertyType.Text != "ArrayProperty" || field.Tag.Size < 4) return true;
        Field(field, "ArrayProperty");
        return archive.Read<int>() != 0;
    }

    internal static double[] Components(int count, Func<double> read)
    {
        var result = new double[count];
        for (var i = 0; i < count; i++)
        {
            var value = read();
            if (!(Math.Abs(value) <= MaximumComponent)) throw ZenPackage.Invalid();
            result[i] = value;
        }
        return result;
    }
}
