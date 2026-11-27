using UnityEditor;
using UnityEngine;

internal static class BundleFixtureSprites
{
    public static string[] Create(string root)
    {
        var sheet = new Texture2D(8, 8, TextureFormat.RGBA32, false) { name = "SpriteSheet" };
        var pixels = new Color32[64];
        for (int y = 0; y < 8; y++)
            for (int x = 0; x < 8; x++)
                pixels[y * 8 + x] = new Color32((byte)(32 * x), (byte)(32 * y), 99, (byte)(11 * (x + y)));
        sheet.SetPixels32(pixels);
        sheet.Apply();
        AssetDatabase.CreateAsset(sheet, root + "/SpriteSheet.asset");

        var external = AssetDatabase.LoadAssetAtPath<Texture2D>(root + "/Albedo.asset");
        return new[] {
            CreateSprite(root, sheet, "LowerSprite", new Rect(1, 0, 3, 4), SpriteMeshType.FullRect),
            CreateSprite(root, sheet, "UpperSprite", new Rect(4, 5, 4, 2), SpriteMeshType.Tight),
            CreateSprite(root, external, "ExternalSprite", new Rect(0, 0, 4, 4), SpriteMeshType.FullRect),
        };
    }

    private static string CreateSprite(string root, Texture2D sheet, string name, Rect rect, SpriteMeshType mesh)
    {
        var sprite = Sprite.Create(sheet, rect, new Vector2(0.5f, 0.5f), 100, 0, mesh);
        sprite.name = name;
        var path = root + "/" + name + ".asset";
        AssetDatabase.CreateAsset(sprite, path);
        return path;
    }
}
