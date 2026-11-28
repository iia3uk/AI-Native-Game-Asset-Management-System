using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

internal static class BundleFixtureMaterialScenes
{
    public static string[] Create(string root, Mesh source)
    {
        var directory = root + "/Scenes";
        Directory.CreateDirectory(directory);
        AssetDatabase.Refresh();
        var mesh = Object.Instantiate(source);
        mesh.name = "SharedSceneMesh";
        AssetDatabase.CreateAsset(mesh, directory + "/SharedSceneMesh.asset");
        var front = AssetDatabase.LoadAssetAtPath<Material>(root + "/Materials/Front.mat");
        var back = AssetDatabase.LoadAssetAtPath<Material>(root + "/Materials/Back.mat");
        return new[] { SaveScene(directory, "PaintedSceneA", mesh, front, back),
            SaveScene(directory, "PaintedSceneB", mesh, front, back) };
    }

    private static string SaveScene(string directory, string name, Mesh mesh, params Material[] materials)
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var item = new GameObject(name, typeof(MeshFilter), typeof(MeshRenderer));
        item.GetComponent<MeshFilter>().sharedMesh = mesh;
        item.GetComponent<MeshRenderer>().sharedMaterials = materials;
        var path = directory + "/" + name + ".unity";
        if (!EditorSceneManager.SaveScene(scene, path))
            throw new System.InvalidOperationException("Unity failed to save the material fixture scene.");
        return path;
    }
}
