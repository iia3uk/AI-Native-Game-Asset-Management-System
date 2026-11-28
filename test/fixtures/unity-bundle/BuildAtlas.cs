using System.IO;
using UnityEditor;
using UnityEditor.U2D;
using UnityEngine;
using UnityEngine.U2D;

public static class AssetViewerAtlasFixture
{
    private const BuildTarget Target = BuildTarget.StandaloneWindows64;

    public static void Build()
    {
        EditorSettings.spritePackerMode = SpritePackerMode.AlwaysOnAtlas;
        const string root = "Assets/AtlasFixture";
        Directory.CreateDirectory(root);
        AssetDatabase.Refresh();
        var panel = CreateImage(root, "Panel", 13, 9, 41);
        var button = CreateImage(root, "Button", 8, 6, 103);
        var atlas = new SpriteAtlas();
        atlas.SetPackingSettings(new SpriteAtlasPackingSettings { padding = 4, enableRotation = false, enableTightPacking = false });
        atlas.SetTextureSettings(new SpriteAtlasTextureSettings { readable = true, generateMipMaps = false, sRGB = true });
        atlas.SetPlatformSettings(new TextureImporterPlatformSettings { name = "Standalone", overridden = true,
            format = TextureImporterFormat.RGBA32, maxTextureSize = 128, textureCompression = TextureImporterCompression.Uncompressed });
        atlas.SetIncludeInBuild(true);
        atlas.Add(new Object[] { AssetDatabase.LoadAssetAtPath<Sprite>(panel), AssetDatabase.LoadAssetAtPath<Sprite>(button) });
        var atlasPath = root + "/FixtureAtlas.spriteatlas";
        AssetDatabase.CreateAsset(atlas, atlasPath);
        AssetDatabase.SaveAssets();
        SpriteAtlasUtility.PackAtlases(new[] { atlas }, Target, false);
        if (atlas.spriteCount != 2) throw new System.InvalidOperationException("Unity did not pack the fixture atlas.");

        var output = Path.GetFullPath(Path.Combine(Application.dataPath, "../..", "Bundles", "Atlas"));
        Directory.CreateDirectory(output);
        var mapping = new AssetBundleBuild { assetBundleName = "atlas.bundle", assetNames = new[] { atlasPath, panel, button } };
        if (BuildPipeline.BuildAssetBundles(output, new[] { mapping },
            BuildAssetBundleOptions.UncompressedAssetBundle | BuildAssetBundleOptions.StrictMode, Target) == null)
            throw new System.InvalidOperationException("Unity failed to build the fixture atlas.");
    }

    private static string CreateImage(string root, string name, int width, int height, byte blue)
    {
        var texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
        var pixels = new Color32[width * height];
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
                pixels[y * width + x] = new Color32((byte)(13 * x + 2), (byte)(19 * y + 5), blue, (byte)(91 + 3 * (x + y)));
        texture.SetPixels32(pixels);
        texture.Apply();
        var path = root + "/" + name + ".png";
        File.WriteAllBytes(path, ImageConversion.EncodeToPNG(texture));
        Object.DestroyImmediate(texture);
        AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
        var importer = (TextureImporter)AssetImporter.GetAtPath(path);
        importer.textureType = TextureImporterType.Sprite;
        importer.spriteImportMode = SpriteImportMode.Single;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.mipmapEnabled = false;
        importer.alphaIsTransparency = false;
        importer.npotScale = TextureImporterNPOTScale.None;
        var settings = new TextureImporterSettings();
        importer.ReadTextureSettings(settings);
        settings.spriteMeshType = SpriteMeshType.FullRect;
        importer.SetTextureSettings(settings);
        importer.SaveAndReimport();
        return path;
    }
}
