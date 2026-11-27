using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class AssetViewerPlayerFixture
{
    public static void Build()
    {
        const string resources = "Assets/Resources";
        Directory.CreateDirectory(resources);
        AssetDatabase.Refresh();
        BundleFixtureTextures.Create(resources);
        BundleFixtureAudio.Create(resources);
        AssetDatabase.SaveAssets();

        const string scenePath = "Assets/Fixture.unity";
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene);
        if (!EditorSceneManager.SaveScene(scene, scenePath))
            throw new InvalidOperationException("Unity could not save the fixture scene.");

        var output = Path.GetFullPath(Path.Combine(Application.dataPath, "../../Player"));
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { scenePath },
            locationPathName = Path.Combine(output, "Fixture.exe"),
            target = BuildTarget.StandaloneWindows64,
            options = BuildOptions.StrictMode,
        });
        if (report.summary.result != BuildResult.Succeeded)
            throw new InvalidOperationException("Unity Player fixture build failed: " + report.summary.result);
    }
}
