using System.Buffers.Binary;

namespace AssetViewer.Formats;

// DXT1 and DXT5 store little-endian BC1 and BC3 blocks, respectively.
internal static class BlockCompression
{
    private const int Side = 4;

    private static int BlockCount(int size) => (size + Side - 1) / Side;
    public static int Size(int width, int height, bool hasAlphaBlock) =>
        BlockCount(width) * BlockCount(height) * (hasAlphaBlock ? 16 : 8);

    public static byte[] Decode(ReadOnlySpan<byte> source, int width, int height, bool hasAlphaBlock)
    {
        var pixels = new byte[width * height * 4];
        Span<byte> colors = stackalloc byte[16];
        Span<byte> alpha = stackalloc byte[8];
        var blockSize = hasAlphaBlock ? 16 : 8;
        var offset = 0;
        for (var y = 0; y < height; y += Side)
        {
            for (var x = 0; x < width; x += Side)
            {
                var block = source.Slice(offset, blockSize);
                offset += blockSize;
                var colorBlock = hasAlphaBlock ? block[8..] : block;
                ColorPalette(colorBlock, colors, hasAlphaBlock);
                var colorIndices = BinaryPrimitives.ReadUInt32LittleEndian(colorBlock[4..]);
                var alphaIndices = hasAlphaBlock ? AlphaPalette(block[..8], alpha) : 0;

                for (var row = 0; row < Math.Min(Side, height - y); row++)
                {
                    for (var column = 0; column < Math.Min(Side, width - x); column++)
                    {
                        var texel = row * Side + column;
                        var index = (int)((colorIndices >> (texel * 2)) & 3);
                        var at = ((y + row) * width + x + column) * 4;
                        var pixel = pixels.AsSpan(at, 4);
                        colors.Slice(index * 4, 4).CopyTo(pixel);
                        if (hasAlphaBlock) pixel[3] = alpha[(int)((alphaIndices >> (texel * 3)) & 7)];
                    }
                }
            }
        }
        return pixels;
    }

    private static void ColorPalette(ReadOnlySpan<byte> block, Span<byte> colors, bool fourColors)
    {
        var first = BinaryPrimitives.ReadUInt16LittleEndian(block);
        var second = BinaryPrimitives.ReadUInt16LittleEndian(block[2..]);
        Color565(first, colors);
        Color565(second, colors[4..]);
        if (fourColors || first > second)
        {
            for (var channel = 0; channel < 3; channel++)
            {
                colors[8 + channel] = (byte)((2 * colors[channel] + colors[4 + channel]) / 3);
                colors[12 + channel] = (byte)((colors[channel] + 2 * colors[4 + channel]) / 3);
            }
            colors[15] = 255;
        }
        else
        {
            for (var channel = 0; channel < 3; channel++)
                colors[8 + channel] = (byte)((colors[channel] + colors[4 + channel]) / 2);
            colors[12..].Clear();
        }
        colors[11] = 255;
    }

    private static void Color565(ushort value, Span<byte> color)
    {
        var r = value >> 11;
        var g = (value >> 5) & 63;
        var b = value & 31;
        color[0] = (byte)((r << 3) | (r >> 2));
        color[1] = (byte)((g << 2) | (g >> 4));
        color[2] = (byte)((b << 3) | (b >> 2));
        color[3] = 255;
    }

    private static ulong AlphaPalette(ReadOnlySpan<byte> block, Span<byte> alpha)
    {
        alpha[0] = block[0];
        alpha[1] = block[1];
        var steps = alpha[0] > alpha[1] ? 7 : 5;
        for (var index = 1; index < steps; index++)
            alpha[index + 1] = (byte)(((steps - index) * alpha[0] + index * alpha[1]) / steps);
        if (steps == 5)
        {
            alpha[6] = 0;
            alpha[7] = 255;
        }
        return BinaryPrimitives.ReadUInt64LittleEndian(block) >> 16;
    }
}
