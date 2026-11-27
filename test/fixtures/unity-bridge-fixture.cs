using System.IO;
using UnityEditor;
using UnityEngine;

public static class UnityBridgeFixture
{
    public static void Create()
    {
        EditorSettings.serializationMode = SerializationMode.ForceText;
        const string folder = "Assets/Fixture";
        Directory.CreateDirectory(folder);
        AssetDatabase.Refresh();

        var mesh = new Mesh {
            name = "Triangle",
            vertices = new[] { Vector3.zero, Vector3.up, Vector3.right },
            triangles = new[] { 0, 1, 2 },
            uv = new[] { Vector2.zero, Vector2.up, Vector2.right }
        };
        mesh.RecalculateNormals();
        AssetDatabase.CreateAsset(mesh, folder + "/Triangle.asset");

        var root = new GameObject("BridgeFixture");
        foreach (var part in new[] { "LeftPart", "RightPart" })
        {
            var child = new GameObject(part);
            child.transform.SetParent(root.transform, false);
            child.transform.localPosition = part == "LeftPart" ? Vector3.left : Vector3.right;
            if (part == "LeftPart")
            {
                child.AddComponent<MeshFilter>().sharedMesh = mesh;
                child.AddComponent<MeshRenderer>();
            }
            else
            {
                var bone = new GameObject("RigBone").transform;
                bone.SetParent(child.transform, false);
                var skin = Object.Instantiate(mesh);
                skin.name = "Skin";
                skin.bindposes = new[] { bone.worldToLocalMatrix * child.transform.localToWorldMatrix };
                var weight = new BoneWeight { boneIndex0 = 0, weight0 = 1 };
                skin.boneWeights = new[] { weight, weight, weight };
                AssetDatabase.CreateAsset(skin, folder + "/Skin.asset");
                var renderer = child.AddComponent<SkinnedMeshRenderer>();
                renderer.sharedMesh = skin;
                renderer.bones = new[] { bone };
                renderer.rootBone = bone;
            }
        }
        PrefabUtility.SaveAsPrefabAsset(root, folder + "/BridgeFixture.prefab");
        Object.DestroyImmediate(root);

        var clip = new AnimationClip { name = "Lift", legacy = true, frameRate = 30 };
        clip.SetCurve("LeftPart", typeof(Transform), "localPosition.y", AnimationCurve.Linear(0, 0, 1, 2));
        AssetDatabase.CreateAsset(clip, folder + "/Lift.anim");

        var texture = new Texture2D(4, 4, TextureFormat.RGBA32, false) { name = "Albedo" };
        var pixels = new Color32[16];
        for (int i = 0; i < pixels.Length; i++) pixels[i] = new Color32((byte)(i * 12), 64, 128, 255);
        texture.SetPixels32(pixels);
        texture.Apply();
        AssetDatabase.CreateAsset(texture, folder + "/Albedo.asset");

        var material = new Material(Shader.Find("Standard")) { name = "FixtureMaterial", mainTexture = texture };
        AssetDatabase.CreateAsset(material, folder + "/FixtureMaterial.mat");
        AssetDatabase.SaveAssets();
        var output = Path.GetFullPath(Path.Combine(Application.dataPath, "../..", "NativeBridge.unitypackage"));
        AssetDatabase.ExportPackage(folder, output, ExportPackageOptions.Recurse);
    }
}
