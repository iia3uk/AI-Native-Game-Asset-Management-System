using AssetsTools.NET;

namespace AssetViewer.UnityBundle.Objects.Sprites;

internal readonly record struct SpriteFrame(int X, int Y, int CropWidth, int CropHeight,
    int Width, int Height, int OffsetX, int OffsetY, int Rotation)
{
    private const string RectIssue = "unity-bundle-sprite-rect";

    public static SpriteFrame Read(AssetTypeValueField sprite, AssetTypeValueField render, bool packed)
    {
        var settings = render["settingsRaw"];
        if (settings.IsDummy) throw new BundleException("unity-bundle-sprite-packing");
        var flags = settings.AsUInt;
        var rotation = packed ? (int)(flags >> 2 & 0xf) : 0;
        const uint ancillaryMask = 0xc40;
        var packing = flags & ~ancillaryMask;
        var expected = packed ? 3u | (uint)rotation << 2 : 0u;
        if ((flags & ancillaryMask) is not (0 or 0x40 or 0xc00 or 0xc40) || packing != expected || rotation > 3)
            throw new BundleException("unity-bundle-sprite-packing");

        var rect = render["textureRect"];
        var x = Coordinate(rect["x"]);
        var y = Coordinate(rect["y"]);
        var cropWidth = Coordinate(rect["width"]);
        var cropHeight = Coordinate(rect["height"]);
        if (cropWidth == 0 || cropHeight == 0) throw new BundleException(RectIssue);
        if (!packed) return new SpriteFrame(x, y, cropWidth, cropHeight, cropWidth, cropHeight, 0, 0, 0);

        var scale = render["downscaleMultiplier"];
        if (scale.IsDummy || scale.AsFloat != 1) throw new BundleException("unity-bundle-sprite-atlas-variant");
        var frame = sprite["m_Rect"];
        var width = Coordinate(frame["width"]);
        var height = Coordinate(frame["height"]);
        var offset = render["textureRectOffset"];
        var offsetX = Coordinate(offset["x"]);
        var offsetY = Coordinate(offset["y"]);
        if (offsetX + cropWidth > width || offsetY + cropHeight > height)
            throw new BundleException(RectIssue);
        return new SpriteFrame(x, y, cropWidth, cropHeight, width, height, offsetX, offsetY, rotation);
    }

    public void CheckBounds(int textureWidth, int textureHeight)
    {
        if (X + CropWidth > textureWidth || Y + CropHeight > textureHeight)
            throw new BundleException(RectIssue);
    }

    public byte[] Extract(byte[] texture, int textureWidth)
    {
        var pixels = new byte[Width * Height * 4];
        var flipX = (Rotation & 1) != 0;
        var flipY = (Rotation & 2) != 0;
        var stride = CropWidth * 4;
        for (var row = 0; row < CropHeight; row++)
        {
            var sourceY = Y + (flipY ? CropHeight - 1 - row : row);
            var source = texture.AsSpan((sourceY * textureWidth + X) * 4, stride);
            var target = pixels.AsSpan(((OffsetY + row) * Width + OffsetX) * 4, stride);
            if (!flipX)
                source.CopyTo(target);
            else
                for (var col = 0; col < CropWidth; col++)
                    source.Slice((CropWidth - 1 - col) * 4, 4).CopyTo(target.Slice(col * 4, 4));
        }
        return pixels;
    }

    private static int Coordinate(AssetTypeValueField field)
    {
        if (field.IsDummy) throw new BundleException(RectIssue);
        var value = field.AsFloat;
        if (!float.IsFinite(value) || value < 0 || value > 2048 || value != MathF.Truncate(value))
            throw new BundleException(RectIssue);
        return (int)value;
    }
}
