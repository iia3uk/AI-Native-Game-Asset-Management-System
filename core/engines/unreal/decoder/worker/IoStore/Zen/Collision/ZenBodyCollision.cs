using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Readers;

namespace AssetViewer.UnrealDecode.IoStore.Zen.Collision;

internal sealed record ZenCollisionTransform(double[] Rotation, double[] Translation, double[] Scale);
internal sealed record ZenCollisionShape(string Type, string? Name, string? CollisionEnabled, double RestOffset, bool? Generated,
    bool? ContributesToMass, double[]? Center = null, double[]? Rotation = null, double[]? Dimensions = null,
    double? Radius = null, double? Length = null, double[][]? Vertices = null, int[]? Indices = null,
    ZenCollisionTransform? Transform = null);
internal sealed record ZenCollisionOmission(string Field, int? Index = null);
internal sealed record ZenCollisionExport(string Body, string? TraceMode, bool? DoubleSided, double[] BuildScale,
    List<ZenCollisionShape> Shapes, List<ZenCollisionOmission> Omitted);

internal static class ZenBodyCollision
{
    public const int MaxBodies = 128;
    public const int ShapeBudget = 32768;
    private const int MaxShapes = 128;

    public static ZenCollisionExport? Read(byte[] chunk, byte[] mesh, ZenPackage package, ref int remainingBodies, ref int available)
    {
        if (package.MeshExports?.ReadBody(chunk, mesh, package, ref remainingBodies) is not { } body) return null;
        if (available == 0) throw new InputException("limit");
        using var source = new FByteArchive("ZenBodySetup", body.Bytes, package.Version);
        using var archive = new FAssetArchive(source, package);
        var properties = CollisionProperties.Read(archive, archive.Length, root: true);
        var traceMode = properties.Name("CollisionTraceFlag", "ECollisionTraceFlag");
        var doubleSided = properties.Bool("bDoubleSidedGeometry");
        var buildScale = properties.Vector("BuildScale3D", "Vector", [1, 1, 1]);
        var aggregate = properties.Struct("AggGeom", "KAggregateGeom");
        var shapes = new List<ZenCollisionShape>();
        var omitted = new List<ZenCollisionOmission>();
        var remaining = MaxShapes;
        if (aggregate != null)
        {
            foreach (var (name, field) in aggregate.Fields)
            {
                if (omitted.Count >= MaxShapes || !ZenImports.ValidObject(name)) throw ZenPackage.Invalid();
                var (descriptor, type) = name switch
                {
                    "BoxElems" => ("KBoxElem", "box"),
                    "SphereElems" => ("KSphereElem", "sphere"),
                    "SphylElems" => ("KSphylElem", "capsule"),
                    "ConvexElems" => ("KConvexElem", "convex"),
                    _ => ("", ""),
                };
                if (type.Length == 0)
                {
                    if (aggregate.HasElements(field)) omitted.Add(new(name));
                    continue;
                }
                var previous = shapes.Count;
                var omissions = omitted.Count;
                try
                {
                    var (count, end) = aggregate.StructArray(field, descriptor, remaining);
                    remaining -= count;
                    for (var index = 0; index < count; index++)
                    {
                        var row = CollisionProperties.Read(archive, end);
                        var next = archive.Position;
                        try { shapes.Add(Shape(row, type)); }
                        catch (InputException) { omitted.Add(new(name, index)); }
                        archive.Position = next;
                    }
                    if (archive.Position != end) throw ZenPackage.Invalid();
                }
                catch (InputException)
                {
                    shapes.RemoveRange(previous, shapes.Count - previous);
                    omitted.RemoveRange(omissions, omitted.Count - omissions);
                    omitted.Add(new(name));
                }
            }
        }
        if (omitted.Count > MaxShapes) throw ZenPackage.Invalid();
        if (shapes.Count == 0 && omitted.Count == 0 && traceMode == null && doubleSided != true &&
            buildScale.All(value => value == 1)) return null;
        var weight = 1 + omitted.Count + shapes.Sum(shape => 8 + 3 * (shape.Vertices?.Length ?? 0) + (shape.Indices?.Length ?? 0));
        if (weight > available) throw new InputException("limit");
        available -= weight;
        return new(body.Name, traceMode, doubleSided, buildScale, shapes, omitted);
    }

    private static ZenCollisionShape Shape(CollisionProperties row, string type)
    {
        var shape = new ZenCollisionShape(type, row.Name("Name"), row.Name("CollisionEnabled", "ECollisionEnabled"),
            row.Scalar("RestOffset", -CollisionProperties.MaximumComponent, 0), row.Bool("bIsGenerated"), row.Bool("bContributeToMass"));
        if (type == "convex")
        {
            var vertices = row.Vertices();
            var transform = row.Transform();
            var magnitude = Math.Sqrt(transform.Rotation.Sum(value => value * value));
            if (Math.Abs(magnitude - 1) > 0.001 || transform.Scale.Any(value => Math.Abs(value) is < 1e-6 or > 1e4))
                throw ZenPackage.Invalid();
            return shape with { Vertices = vertices, Indices = row.Indices(vertices.Length), Transform = transform };
        }
        var center = row.Vector("Center", "Vector", [0, 0, 0]);
        if (type == "sphere") return shape with { Center = center, Radius = row.Scalar("Radius", 1e-6) };
        var rotation = row.Vector("Rotation", "Rotator", [0, 0, 0]);
        return type == "box" ?
            shape with { Center = center, Rotation = rotation, Dimensions = [row.Scalar("X", 1e-6), row.Scalar("Y", 1e-6), row.Scalar("Z", 1e-6)] } :
            shape with { Center = center, Rotation = rotation, Radius = row.Scalar("Radius", 1e-6), Length = row.Scalar("Length", 0) };
    }
}
