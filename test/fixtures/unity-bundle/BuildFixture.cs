using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class AssetViewerBundleFixture
{
    public static void Build()
    {
        EditorSettings.serializationMode = SerializationMode.ForceBinary;
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

        var textures = BundleFixtureTextures.Create(root);
        var sprites = BundleFixtureSprites.Create(root);
        var audio = BundleFixtureAudio.Create(root);
        var materials = BundleFixtureMaterials.Create(root, mesh);
        var scenes = BundleFixtureMaterialScenes.Create(root, mesh);
        AssetDatabase.SaveAssets();

        var output = Path.GetFullPath(Path.Combine(Application.dataPath, "../..", "Bundles"));
        Directory.CreateDirectory(output);
        var mapping = new AssetBundleBuild
        {
            assetBundleName = "fixture.bundle",
            assetNames = new[] { root + "/Triangle.asset", root + "/Line.asset" }.Concat(textures).ToArray()
        };
        var mappings = new[] { mapping,
            new AssetBundleBuild { assetBundleName = "sprites.bundle", assetNames = sprites },
            new AssetBundleBuild { assetBundleName = "audio.bundle", assetNames = audio },
            new AssetBundleBuild { assetBundleName = "materials.bundle", assetNames = materials },
            new AssetBundleBuild { assetBundleName = "scene-materials.bundle", assetNames = scenes },
        }.Concat(BundleFixtureMaterials.CreateLinked(root, mesh)).ToArray();
        if (BuildPipeline.BuildAssetBundles(output, mappings,
            BuildAssetBundleOptions.ChunkBasedCompression | BuildAssetBundleOptions.StrictMode,
            BuildTarget.StandaloneWindows64) == null)
            throw new System.InvalidOperationException("Unity failed to build the fixture AssetBundle.");

        var uncompressed = Path.Combine(output, "uncompressed");
        Directory.CreateDirectory(uncompressed);
        if (BuildPipeline.BuildAssetBundles(uncompressed, mappings,
            BuildAssetBundleOptions.UncompressedAssetBundle | BuildAssetBundleOptions.StrictMode,
            BuildTarget.StandaloneWindows64) == null)
            throw new System.InvalidOperationException("Unity failed to build the uncompressed fixture AssetBundle.");

        AssetViewerAtlasFixture.Build();
    }
}
