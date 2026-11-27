using System.IO;
using UnityEditor;
using UnityEngine;

public static class AssetViewerBundleFixture
{
    public static void Build()
    {
        const string root = "Assets/BundleFixture";
        Directory.CreateDirectory(root);
        AssetDatabase.Refresh();

        var mesh = new Mesh
        {
            name = "BundleTriangle",
            vertices = new[] { Vector3.zero, Vector3.up, Vector3.right,
                new Vector3(2, 0, 1), new Vector3(2, 1, 1), new Vector3(3, 0, 1) },
            uv = new[] { Vector2.zero, Vector2.up, Vector2.right, Vector2.zero, Vector2.up, Vector2.right },
            subMeshCount = 2,
        };
        mesh.SetTriangles(new[] { 0, 1, 2 }, 0);
        mesh.SetTriangles(new[] { 3, 4, 5 }, 1);
        mesh.RecalculateNormals();
        AssetDatabase.CreateAsset(mesh, root + "/Triangle.asset");

        var line = new Mesh { name = "UnsupportedLine", vertices = new[] { Vector3.zero, Vector3.up, Vector3.right } };
        line.SetIndices(new[] { 0, 1 }, MeshTopology.Lines, 0);
        AssetDatabase.CreateAsset(line, root + "/Line.asset");

        var texture = new Texture2D(4, 4, TextureFormat.RGBA32, false) { name = "BundleAlbedo" };
        for (int y = 0; y < texture.height; y++)
            for (int x = 0; x < texture.width; x++)
                texture.SetPixel(x, y, new Color32((byte)(32 * x), (byte)(32 * y), 96, 255));
        texture.Apply();
        AssetDatabase.CreateAsset(texture, root + "/Albedo.asset");
        AssetDatabase.SaveAssets();

        var output = Path.GetFullPath(Path.Combine(Application.dataPath, "../..", "Bundles"));
        Directory.CreateDirectory(output);
        var mapping = new AssetBundleBuild
        {
            assetBundleName = "fixture.bundle",
            assetNames = new[] { root + "/Triangle.asset", root + "/Albedo.asset", root + "/Line.asset" }
        };
        if (BuildPipeline.BuildAssetBundles(output, new[] { mapping },
            BuildAssetBundleOptions.ChunkBasedCompression | BuildAssetBundleOptions.StrictMode,
            BuildTarget.StandaloneWindows64) == null)
            throw new System.InvalidOperationException("Unity failed to build the fixture AssetBundle.");
    }
}
