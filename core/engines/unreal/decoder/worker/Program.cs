using System.Text.Json;
using AssetViewer.UnrealDecode.IoStore;
using AssetViewer.UnrealDecode.Loose;
using AssetViewer.UnrealDecode.Objects.Audio;
using AssetViewer.UnrealDecode.Pak;

namespace AssetViewer.UnrealDecode;

internal static class Program
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { MaxDepth = 12 };
    private const string Backend = "cue4parse";
    private const string BackendVersion = "1.2.2.202611";

    public static int Main(string[] args)
    {
        if (args is ["--probe"])
        {
            Write(new { protocol = 1, backend = Backend, backendVersion = BackendVersion,
                modes = new[] { "pak", "iostore", "loose-textures", "loose-meshes", "loose-audio" } });
            return 0;
        }
        if (args is not ["--decode"]) return 2;

        string? format = null;
        try
        {
            using var stream = File.OpenRead("request.json");
            if (stream.Length > 4096) throw new InputException("unreal-worker-request");
            var request = JsonSerializer.Deserialize<Request>(stream, Json);
            if (request is not { Protocol: 1, Format: "pak" or "iostore" or "loose-textures" or "loose-meshes" or "loose-audio",
                MaxOutputBytes: >= 0 and <= 1L << 30 })
                throw new InputException("unreal-worker-request");
            format = request.Format;
            if (format == "loose-textures") Write(LooseTextures.Read(request));
            else if (format == "loose-audio") Write(LooseAudio.Read(request));
            else if (format == "loose-meshes") Write(LooseMeshes.Read(request));
            else if (format == "iostore") Write(IoStoreDecoder.Read(request));
            else Write(PakDecoder.Read(request));
            return 0;
        }
        catch (InputException error)
        {
            Write(new { protocol = 1, status = "failed", issue = error.Code });
            return 1;
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            Write(new { protocol = 1, status = "failed",
                issue = format switch
                {
                    "loose-textures" => "unreal-loose-textures-decode-failed",
                    "loose-meshes" => "unreal-loose-meshes-decode-failed",
                    "loose-audio" => "unreal-loose-audio-decode-failed",
                    "iostore" => "unreal-iostore-decode-failed",
                    _ => "unreal-pak-decode-failed"
                } });
            return 1;
        }
    }

    private static void Write<T>(T response) => Console.WriteLine(JsonSerializer.Serialize(response, Json));
}

internal sealed record Request(int Protocol, string Format, bool InspectOnly, long MaxOutputBytes, int Count = 0);
internal sealed record TextureExport(int Width, int Height, int Mip, string PixelFormat, bool Srgb, bool NormalZReconstructed, long Size = 0);
internal sealed record Entry(string Path, long Size, string Status, string? Issue, int? Output,
    TextureExport? Texture = null, string? TextureIssue = null, AudioExport? Audio = null, string? AudioIssue = null);
internal sealed record Report(int Protocol, string Status, int ContainerVersion, IReadOnlyList<Entry> Entries, int TextureDecoder, int AudioDecoder);
internal sealed class InputException(string code) : Exception(code)
{
    public string Code { get; } = code;
}
