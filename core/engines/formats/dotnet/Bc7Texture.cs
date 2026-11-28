using System.Runtime.InteropServices;
using BCnEncoder.Decoder;
using BCnEncoder.Shared;

namespace AssetViewer.Formats;

internal static class Bc7Texture
{
    private const int BlockPixels = 4;
    private const int BlockBytes = 16;

    public static byte[]? Decode(ReadOnlySpan<byte> input, int width, int height)
    {
        if (input.Length != BlockCompression.Size(width, height, true))
            return null;
        for (var offset = 0; offset < input.Length; offset += BlockBytes)
        {
            if (input[offset] == 0) return null;
        }

        var decoder = new BcDecoder();
        decoder.Options.IsParallel = false;
        var encodedRow = new byte[BlockCompression.Size(width, BlockPixels, true)];
        var rgba = new byte[width * height * 4];
        for (var y = 0; y < height; y += BlockPixels)
        {
            input.Slice(y / BlockPixels * encodedRow.Length, encodedRow.Length).CopyTo(encodedRow);
            var rows = Math.Min(BlockPixels, height - y);
            var pixels = decoder.DecodeRaw(encodedRow, width, rows, CompressionFormat.Bc7);
            MemoryMarshal.AsBytes(pixels.AsSpan()).CopyTo(rgba.AsSpan(y * width * 4));
        }
        return rgba;
    }
}
