using System.Globalization;
using AssetViewer.UnrealDecode.Objects;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;

namespace AssetViewer.UnrealDecode.Loose;

internal static class LooseMeshes
{
    private const long MaxDecodedBytes = 256L * 1024 * 1024;
    private static readonly string[] MeshClasses = ["StaticMesh", "SkeletalMesh"];

    public static object Read(Request request)
    {
        if (request.InspectOnly || request.Count is < 1 or > 128) throw new InputException("unreal-worker-request");
        CUE4Parse.Globals.FatalObjectSerializationErrors = true;
        var remaining = Math.Min(request.MaxOutputBytes, MaxDecodedBytes);
        var entries = new List<LooseMeshRow>(request.Count);
        for (var index = 0; index < request.Count; index++)
        {
            var stem = index.ToString("D5", CultureInfo.InvariantCulture);
            try
            {
                var header = Input(stem + ".uasset") ?? throw new InputException("unreal-cooked-mesh-io");
                var exports = Input(stem + ".uexp");
                var bulk = Input(stem + ".ubulk");
                var optional = Input(stem + ".uptnl");
                var mesh = CookedPackage.Read(header, exports, bulk, optional, MeshClasses, "unreal-cooked-mesh",
                    (asset, package) => asset switch
                    {
                        UStaticMesh model => CookedStaticMesh.Write(model, package, stem, remaining),
                        USkeletalMesh model => CookedSkeletalMesh.Write(model, package, stem, remaining),
                        _ => throw new InputException("unreal-cooked-mesh-layout"),
                    });
                entries.Add(new LooseMeshRow(index, mesh));
                if (mesh != null) remaining -= mesh.Lods.Sum(lod => lod.Size);
            }
            catch (InputException error) { entries.Add(new LooseMeshRow(index, Issue: error.Code)); }
            catch (IOException) { entries.Add(new LooseMeshRow(index, Issue: "unreal-cooked-mesh-io")); }
        }
        return new { protocol = 1, status = "completed", meshDecoder = 2, entries };
    }

    private static CookedInput? Input(string path)
    {
        var file = new FileInfo(path);
        return file.Exists ? new CookedInput(path, file.Length) : null;
    }

    private sealed record LooseMeshRow(int Index, MeshExport? Mesh = null, string? Issue = null);
}
