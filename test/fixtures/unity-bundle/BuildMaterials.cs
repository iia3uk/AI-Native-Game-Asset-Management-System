using System.IO;
using UnityEditor;
using UnityEngine;

internal static class BundleFixtureMaterials
{
    public static AssetBundleBuild[] CreateLinked(string root, Mesh source)
    {
        root += "/LinkedMaterials";
        Directory.CreateDirectory(root);
        AssetDatabase.Refresh();
        var shader = Shader.Find("Standard");
        var paint = SaveMaterial(root, shader, "LinkedPaint", new Color32(83, 109, 221, 255));
        var mesh = SaveMesh(root, source, "LinkedMesh");
        var prefab = SavePrefab(root, "LinkedBody", mesh, paint, paint);
        return new[] {
            new AssetBundleBuild { assetBundleName = "linked-model.bundle", assetNames = new[] { prefab } },
            new AssetBundleBuild { assetBundleName = "linked-paint.bundle", assetNames = new[] { root + "/LinkedPaint.mat" } },
            new AssetBundleBuild { assetBundleName = "linked-images.bundle", assetNames = new[] { root + "/LinkedPaintColor.asset" } },
        };
    }

    public static string[] Create(string root, Mesh source)
    {
        root += "/Materials";
        Directory.CreateDirectory(root);
        AssetDatabase.Refresh();
        var shader = Shader.Find("Standard");
        if (!shader) throw new System.InvalidOperationException("The fixture requires the built-in Standard shader.");
        var front = SaveMaterial(root, shader, "Front", new Color32(211, 19, 41, 201));
        var back = SaveMaterial(root, shader, "Back", new Color32(11, 191, 73, 255));
        front.SetTextureScale("_MainTex", new Vector2(2, .5f));
        front.SetTextureOffset("_MainTex", new Vector2(.25f, .125f));
        front.SetFloat("_Mode", 1);
        front.SetFloat("_Cutoff", .35f);
        front.EnableKeyword("_ALPHATEST_ON");
        EditorUtility.SetDirty(front);
        var painted = SaveMesh(root, source, "Painted");
        var ambiguous = SaveMesh(root, source, "Shared");
        return new[] {
            SavePrefab(root, "PaintedBody", painted, front, back),
            SavePrefab(root, "FirstVariant", ambiguous, front, back),
            SavePrefab(root, "SecondVariant", ambiguous, back, front),
        };
    }

    private static Material SaveMaterial(string root, Shader shader, string name, Color32 color)
    {
        var texture = new Texture2D(4, 4, TextureFormat.RGBA32, false) { name = name + "Color" };
        var pixels = new Color32[16];
        for (var i = 0; i < pixels.Length; i++) pixels[i] = color;
        texture.SetPixels32(pixels);
        texture.Apply();
        AssetDatabase.CreateAsset(texture, root + "/" + texture.name + ".asset");
        var material = new Material(shader) { name = name, mainTexture = texture };
        AssetDatabase.CreateAsset(material, root + "/" + name + ".mat");
        return material;
    }

    private static Mesh SaveMesh(string root, Mesh source, string name)
    {
        var mesh = Object.Instantiate(source);
        mesh.name = name;
        AssetDatabase.CreateAsset(mesh, root + "/" + name + ".asset");
        return mesh;
    }

    private static string SavePrefab(string root, string name, Mesh mesh, params Material[] materials)
    {
        var body = new GameObject(name, typeof(MeshFilter), typeof(MeshRenderer));
        body.GetComponent<MeshFilter>().sharedMesh = mesh;
        body.GetComponent<MeshRenderer>().sharedMaterials = materials;
        var path = root + "/" + name + ".prefab";
        PrefabUtility.SaveAsPrefabAsset(body, path);
        Object.DestroyImmediate(body);
        return path;
    }
}
