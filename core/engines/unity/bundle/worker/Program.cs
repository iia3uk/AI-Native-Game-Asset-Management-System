using System.Text.Json;
using System.Text.Json.Serialization;
using AssetViewer.UnityBundle.Objects.Materials;
using AssetViewer.UnityBundle.Serialized;
using AssetViewer.UnityBundle.UnityFs;

namespace AssetViewer.UnityBundle;

internal static class Program
{
    public const int DecoderRevision = 11;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { MaxDepth = 10 };

    public static int Main(string[] args)
    {
        if (args is ["--probe"])
        {
            Write(new { protocol = 1, decoderRevision = DecoderRevision, backend = "AssetsTools.NET", backendVersion = "3.0.5" });
            return 0;
        }
        if (args is not ["--decode"]) return 2;
        try
        {
            using var stream = File.OpenRead("request.json");
            if (stream.Length > 4096) throw new BundleException("unity-bundle-request");
            var request = JsonSerializer.Deserialize<Request>(stream, Json);
            if (request is not { Protocol: 1, OutputLimit: >= 0 and <= 128L << 20, BundleDependencies: >= 0 and <= 8 } ||
                (request.Serialized && request.BundleDependencies != 0))
                throw new BundleException("unity-bundle-request");
            Write(request.Serialized
                ? SerializedFile.Read(request.InspectOnly, request.OutputLimit, request.Companions)
                : BundleObjects.Read(request.InspectOnly, request.OutputLimit, request.BundleDependencies));
            return 0;
        }
        catch (BundleException error)
        {
            Write(new { protocol = 1, status = "failed", issue = error.Message });
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            Write(new { protocol = 1, status = "failed", issue = "unity-bundle-read-failed" });
        }
        return 1;
    }

    private static void Write<T>(T data) => Console.WriteLine(JsonSerializer.Serialize(data, Json));
}

internal sealed record Request(int Protocol, bool InspectOnly, long OutputLimit, bool Serialized = false,
    CompanionNames? Companions = null, int BundleDependencies = 0);
internal sealed record Asset(string Member, string PathId, int ClassId, string? Name, string Status, string? Issue,
    int? Width = null, int? Height = null, int? Output = null, string? Format = null,
    int? Vertices = null, int? Triangles = null, int? Bytes = null,
    string? TextureEncoding = null, string? TextureStorage = null, SpriteSource? Sprite = null, AudioSource? Audio = null,
    string? TextureColorSpace = null, MaterialSource? Material = null, MeshBindings? MeshMaterials = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] int SourceArchive = 0,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] TextureSampling? Sampler = null);
internal sealed record Product(string Name, string Format, byte[] Bytes,
    int? Width = null, int? Height = null, int? Vertices = null, int? Triangles = null,
    string? TextureEncoding = null, string? TextureStorage = null, SpriteSource? Sprite = null, AudioSource? Audio = null,
    string? TextureColorSpace = null, TextureSampling? Sampler = null);
internal sealed record TextureSampling(int Filter, int WrapU, int WrapV, int Anisotropy, bool Mipmaps);
internal sealed record SpriteSource(string TexturePathId, int X, int Y, PackedSprite? Packed = null);
internal sealed record PackedSprite(string AtlasPathId, int Width, int Height, int OffsetX, int OffsetY, int Rotation);
internal sealed record AudioSource(int Channels, int SampleRate, int Frames);
internal sealed record Report(int Protocol, int DecoderRevision, string Status, uint Format, string UnityVersion,
    IReadOnlyList<Asset> Assets);
internal sealed class BundleException(string code) : Exception(code);
