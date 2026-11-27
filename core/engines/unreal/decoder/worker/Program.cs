using System.Text.Json;
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
            Write(new { protocol = 1, backend = Backend, backendVersion = BackendVersion, modes = new[] { "pak" } });
            return 0;
        }
        if (args is not ["--decode"]) return 2;

        try
        {
            using var stream = File.OpenRead("request.json");
            if (stream.Length > 4096) throw new InputException("unreal-worker-request");
            var request = JsonSerializer.Deserialize<Request>(stream, Json);
            if (request is not { Protocol: 1, Format: "pak", MaxOutputBytes: >= 0 and <= 1L << 30 })
                throw new InputException("unreal-worker-request");
            var report = PakDecoder.Read(request);
            Write(report);
            return 0;
        }
        catch (InputException error)
        {
            Write(new { protocol = 1, status = "failed", issue = error.Code });
            return 1;
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            Write(new { protocol = 1, status = "failed", issue = "unreal-pak-decode-failed" });
            return 1;
        }
    }

    private static void Write<T>(T response) => Console.WriteLine(JsonSerializer.Serialize(response, Json));
}

internal sealed record Request(int Protocol, string Format, bool InspectOnly, long MaxOutputBytes);
internal sealed record Entry(string Path, long Size, string Status, string? Issue, int? Output);
internal sealed record Report(int Protocol, string Status, int ContainerVersion, IReadOnlyList<Entry> Entries);
internal sealed class InputException(string code) : Exception(code)
{
    public string Code { get; } = code;
}
