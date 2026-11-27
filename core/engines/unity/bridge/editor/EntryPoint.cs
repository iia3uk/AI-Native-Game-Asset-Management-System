using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEditor;
using UnityEditor.Formats.Fbx.Exporter;

namespace AssetViewerBridge
{
    public static class EntryPoint
    {
        public static void Export()
        {
            string root = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            var request = JsonUtility.FromJson<Request>(File.ReadAllText(Path.Combine(root, "bridge-request.json")));
            var output = Path.Combine(root, "BridgeOutput");
            Directory.CreateDirectory(output);
            var results = new List<Result>();
            foreach (var target in request.targets)
            {
                var products = new List<Product>();
                var result = new Result { id = target.id };
                try
                {
                    var directory = Path.Combine(output, target.id);
                    Directory.CreateDirectory(directory);
                    if (target.kind == "prefab") result.issue = FbxAssets.ExportPrefab(target.path, directory, products);
                    else AssetObjects.Export(target.path, directory, products);
                    if (products.Count == 0 && string.IsNullOrEmpty(result.issue)) result.issue = "unity-object-unsupported";
                }
                catch (Exception exception)
                {
                    Debug.LogException(exception);
                    result.issue = "unity-asset-import-or-export-failed";
                }
                result.products = products.ToArray();
                results.Add(result);
            }
            var exporter = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(ModelExporter).Assembly);
            var response = new Response { editorVersion = Application.unityVersion, exporterVersion = exporter?.version, results = results.ToArray() };
            File.WriteAllText(Path.Combine(root, "bridge-result.json"), JsonUtility.ToJson(response));
        }
    }
}
