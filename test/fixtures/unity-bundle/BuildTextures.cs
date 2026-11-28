using System.IO;
using UnityEditor;
using UnityEngine;

internal static class BundleFixtureTextures
{
    public static string[] Create(string root)
    {
        var texture = new Texture2D(4, 4, TextureFormat.RGBA32, false) { name = "BundleAlbedo" };
        for (int y = 0; y < texture.height; y++)
            for (int x = 0; x < texture.width; x++)
                texture.SetPixel(x, y, new Color32((byte)(32 * x), (byte)(32 * y), 96, 255));
        texture.Apply();
        AssetDatabase.CreateAsset(texture, root + "/Albedo.asset");

        // Two BC1 blocks use the same four indices in every row and both endpoint orders.
        var dxt1 = SaveCompressed(root, "InlineDXT1", TextureFormat.DXT1, new byte[] {
            0x00, 0xf8, 0x1f, 0x00, 0xe4, 0xe4, 0xe4, 0xe4,
            0x00, 0x00, 0xe0, 0x07, 0xe4, 0xe4, 0xe4, 0xe4,
        });
        // BC3 uses four colors in both blocks and both modes of the alpha palette.
        var dxt5 = SaveCompressed(root, "InlineDXT5", TextureFormat.DXT5, new byte[] {
            217, 7, 0x88, 0xc6, 0xfa, 0x88, 0xc6, 0xfa, 0x1f, 0x00, 0x00, 0xf8, 0xe4, 0xe4, 0xe4, 0xe4,
            20, 220, 0x88, 0xc6, 0xfa, 0x88, 0xc6, 0xfa, 0x1f, 0x00, 0x00, 0xf8, 0xe4, 0xe4, 0xe4, 0xe4,
        });
        var bc4 = SaveCompressed(root, "InlineBC4", TextureFormat.BC4, new byte[] {
            217, 7, 0x88, 0xc6, 0xfa, 0x88, 0xc6, 0xfa,
            20, 220, 0x88, 0xc6, 0xfa, 0x88, 0xc6, 0xfa,
        }, linear: true);
        var bc5 = SaveCompressed(root, "InlineBC5", TextureFormat.BC5, new byte[] {
            217, 7, 0x88, 0xc6, 0xfa, 0x88, 0xc6, 0xfa, 30, 200, 0x88, 0xc6, 0xfa, 0x88, 0xc6, 0xfa,
            20, 220, 0x88, 0xc6, 0xfa, 0x88, 0xc6, 0xfa, 180, 40, 0x88, 0xc6, 0xfa, 0x88, 0xc6, 0xfa,
        }, linear: true);
        // Two mode 6 blocks with constant RGBA endpoints.
        var bc7 = SaveCompressed(root, "InlineBC7", TextureFormat.BC7, new byte[] {
            0xc0, 0x48, 0x84, 0xc5, 0x62, 0x32, 0xb5, 0x5a, 0, 0, 0, 0, 0, 0, 0, 0,
            0x40, 0x97, 0xcb, 0x62, 0xf9, 0xfd, 0x4e, 0x27, 0, 0, 0, 0, 0, 0, 0, 0,
        });
        return new[] { root + "/Albedo.asset", dxt1, dxt5, bc4, bc5, bc7,
            SaveImported(root, "StreamedDXT5", TextureImporterFormat.DXT5, true),
            SaveImported(root, "StreamedBC7", TextureImporterFormat.BC7, false) };
    }

    private static string SaveCompressed(string root, string name, TextureFormat format, byte[] bytes, bool linear = false)
    {
        var texture = new Texture2D(8, 4, format, false, linear) { name = name };
        texture.SetPixelData(bytes, 0);
        texture.Apply(false);
        var path = root + "/" + name + ".asset";
        AssetDatabase.CreateAsset(texture, path);
        return path;
    }

    private static string SaveImported(string root, string name, TextureImporterFormat format, bool srgb)
    {
        const int size = 512;
        var source = new Texture2D(size, size, TextureFormat.RGBA32, false);
        var pixels = new Color32[size * size];
        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
                pixels[y * size + x] = y < size / 2 ? new Color32(255, 0, 0, 51) : new Color32(0, 255, 0, 204);
        source.SetPixels32(pixels);
        source.Apply();
        var path = root + "/" + name + ".png";
        File.WriteAllBytes(path, source.EncodeToPNG());
        Object.DestroyImmediate(source);
        AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
        var importer = (TextureImporter)AssetImporter.GetAtPath(path);
        importer.mipmapEnabled = true;
        importer.streamingMipmaps = true;
        importer.sRGBTexture = srgb;
        importer.alphaSource = TextureImporterAlphaSource.FromInput;
        importer.SetPlatformTextureSettings(new TextureImporterPlatformSettings
        {
            name = "Standalone",
            overridden = true,
            format = format
        });
        importer.SaveAndReimport();
        return path;
    }
}
