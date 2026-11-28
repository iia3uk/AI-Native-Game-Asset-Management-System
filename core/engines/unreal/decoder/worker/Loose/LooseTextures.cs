using System.Globalization;
using AssetViewer.UnrealDecode.Formats;
using AssetViewer.UnrealDecode.Objects;

namespace AssetViewer.UnrealDecode.Loose;

internal static class LooseTextures
{
    private const long MaxDecodedBytes = 256L * 1024 * 1024;

    public static object Read(Request request)
    {
        if (request.InspectOnly || request.Count is < 1 or > 512) throw new InputException("unreal-worker-request");
        var remaining = Math.Min(request.MaxOutputBytes, MaxDecodedBytes);
        var entries = new List<LooseTextureRow>(request.Count);
        for (var index = 0; index < request.Count; index++)
        {
            var stem = index.ToString("D5", CultureInfo.InvariantCulture);
            try
            {
                var header = Input(stem + ".uasset") ?? throw new InputException("unreal-cooked-texture-io");
                var texture = CookedTexture.Read(header, Input(stem + ".uexp"), Input(stem + ".ubulk"), Input(stem + ".uptnl"), remaining);
                if (texture == null)
                {
                    entries.Add(new LooseTextureRow(index));
                    continue;
                }
                var (data, export) = texture.Value;
                if (Png.MaximumSize(data.Length, export.Height) > remaining)
                    throw new InputException("unreal-cooked-texture-limit");
                using var output = File.Open(Path.Combine("output", stem + ".png"), FileMode.CreateNew, FileAccess.Write);
                Png.Write(output, export.Width, export.Height, data, export.Srgb);
                entries.Add(new LooseTextureRow(index, export with { Size = output.Length }));
                remaining -= output.Length;
            }
            catch (InputException error) { entries.Add(new LooseTextureRow(index, TextureIssue: error.Code)); }
            catch (IOException) { entries.Add(new LooseTextureRow(index, TextureIssue: "unreal-cooked-texture-io")); }
        }
        return new { protocol = 1, status = "completed", textureDecoder = TexturePixels.Revision, entries };
    }

    private static CookedInput? Input(string path)
    {
        var file = new FileInfo(path);
        return file.Exists ? new CookedInput(path, file.Length) : null;
    }

    private sealed record LooseTextureRow(int Index, TextureExport? Texture = null, string? TextureIssue = null);
}
