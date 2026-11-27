using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEditor;
using UnityEditor.Formats.Fbx.Exporter;
using Object = UnityEngine.Object;

namespace AssetViewerBridge
{
    internal static class FbxAssets
    {
        internal static string ExportPrefab(string path, string directory, List<Product> products)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (!prefab) return "unity-prefab-unavailable";
            var root = PrefabUtility.LoadPrefabContents(path);
            try
            {
                var renderers = MeshRenderers(root);
                if (renderers.Length == 0) return "unity-prefab-has-no-geometry";
                AddFbx(root, directory, products, "prefab", root.name, prefab, TriangleCount(renderers));
                for (int part = 0; part < Math.Min(renderers.Length, 100); part++)
                {
                    var copy = Object.Instantiate(root);
                    copy.name = root.name;
                    try
                    {
                        var parts = MeshRenderers(copy);
                        var keep = parts[part];
                        foreach (var renderer in parts)
                        {
                            if (renderer == keep) continue;
                            if (renderer is MeshRenderer && renderer.TryGetComponent<MeshFilter>(out var filter))
                                Object.DestroyImmediate(filter);
                            Object.DestroyImmediate(renderer);
                        }
                        var mesh = SharedMesh(keep);
                        var nodePath = AnimationUtility.CalculateTransformPath(keep.transform, copy.transform);
                        AddFbx(copy, directory, products, "component", keep.name, mesh, TriangleCount(new[] { keep }), nodePath);
                    }
                    finally { Object.DestroyImmediate(copy); }
                }
                return renderers.Length > 100 ? "unity-prefab-component-limit" : null;
            }
            finally { PrefabUtility.UnloadPrefabContents(root); }
        }

        internal static void ExportMesh(Mesh mesh, string directory, List<Product> products)
        {
            var root = new GameObject(mesh.name);
            try
            {
                root.AddComponent<MeshFilter>().sharedMesh = mesh;
                root.AddComponent<MeshRenderer>();
                AddFbx(root, directory, products, "mesh", mesh.name, mesh, TriangleCount(MeshRenderers(root)));
            }
            finally { Object.DestroyImmediate(root); }
        }

        internal static void ExportAnimation(AnimationClip clip, string directory, List<Product> products)
        {
            var root = new GameObject(clip.name);
            var copy = Object.Instantiate(clip);
            try
            {
                copy.name = clip.name;
                copy.legacy = true;
                var bindings = AnimationUtility.GetCurveBindings(clip);
                if (clip.humanMotion || bindings.Length == 0 || bindings.Any(binding => binding.type != typeof(Transform)) ||
                    AnimationUtility.GetObjectReferenceCurveBindings(clip).Length > 0)
                {
                    var product = new Product { role = "animation", format = "fbx", name = clip.name,
                        number = products.Count, issue = "unity-animation-requires-target-rig" };
                    product.SetSource(clip);
                    products.Add(product);
                    return;
                }
                foreach (var binding in bindings)
                {
                    var node = root.transform;
                    if (string.IsNullOrEmpty(binding.path)) continue;
                    foreach (var segment in binding.path.Split('/'))
                    {
                        var child = node.Find(segment);
                        if (!child)
                        {
                            child = new GameObject(segment).transform;
                            child.SetParent(node, false);
                        }
                        node = child;
                    }
                }
                var animation = root.AddComponent<Animation>();
                AnimationUtility.SetAnimationClips(animation, new[] { copy });
                animation.clip = copy;
                AddFbx(root, directory, products, "animation", clip.name, clip, 0);
            }
            finally
            {
                Object.DestroyImmediate(root);
                Object.DestroyImmediate(copy);
            }
        }

        private static Renderer[] MeshRenderers(GameObject root) =>
            root.GetComponentsInChildren<Renderer>(true).Where(renderer => SharedMesh(renderer)).ToArray();

        private static Mesh SharedMesh(Renderer renderer)
        {
            if (renderer is SkinnedMeshRenderer skinned) return skinned.sharedMesh;
            if (renderer is MeshRenderer && renderer.TryGetComponent<MeshFilter>(out var filter)) return filter.sharedMesh;
            return null;
        }

        private static int TriangleCount(IEnumerable<Renderer> renderers)
        {
            long count = 0;
            foreach (var renderer in renderers)
            {
                var mesh = SharedMesh(renderer);
                for (var submesh = 0; submesh < mesh.subMeshCount; submesh++)
                    if (mesh.GetTopology(submesh) == MeshTopology.Triangles) count += mesh.GetIndexCount(submesh) / 3;
            }
            return (int)Math.Min(int.MaxValue, count);
        }

        private static void AddFbx(GameObject root, string directory, List<Product> products, string role, string name,
            Object source, int triangles, string nodePath = null)
        {
            var product = new Product {
                role = role, format = "fbx", name = name, nodePath = nodePath, number = products.Count, triangles = triangles
            };
            product.SetSource(source);
            products.Add(product);
            if (triangles == 0 && role != "animation")
            {
                product.issue = "unity-model-has-no-triangles";
                return;
            }
            var options = new ExportModelOptions {
                ExportFormat = ExportFormat.Binary,
                ModelAnimIncludeOption = role == "animation" ? Include.Anim : Include.ModelAndAnim,
                ObjectPosition = ObjectPosition.WorldAbsolute,
                ExportUnrendered = true,
                AnimateSkinnedMesh = true,
                EmbedTextures = true,
                LODExportType = LODExportType.All,
            };
            try
            {
                var destination = Path.Combine(directory, product.number + ".fbx");
                if (string.IsNullOrEmpty(ModelExporter.ExportObject(destination, root, options)) || !File.Exists(destination))
                    product.issue = "unity-fbx-export-failed";
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                product.issue = "unity-fbx-export-failed";
            }
        }

    }
}
