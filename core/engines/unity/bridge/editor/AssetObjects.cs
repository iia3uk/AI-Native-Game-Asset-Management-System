using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEditor;

namespace AssetViewerBridge
{
    internal static class AssetObjects
    {
        internal static void Export(string path, string directory, List<Product> products)
        {
            foreach (var asset in AssetDatabase.LoadAllAssetsAtPath(path))
            {
                if (products.Count >= 100) return;
                switch (asset)
                {
                    case Mesh mesh:
                        FbxAssets.ExportMesh(mesh, directory, products);
                        break;
                    case AnimationClip clip:
                        FbxAssets.ExportAnimation(clip, directory, products);
                        break;
                    case Texture2D texture:
                        ExportTexture(texture, directory, products);
                        break;
                    case Material material:
                        ExportMaterial(material, directory, products);
                        break;
                }
            }
        }

        private static void ExportTexture(Texture2D texture, string directory, List<Product> products)
        {
            var product = new Product {
                role = "texture", format = "png", name = texture.name, number = products.Count,
                width = texture.width, height = texture.height, colorSpace = texture.isDataSRGB ? "srgb" : "linear"
            };
            product.SetSource(texture);
            products.Add(product);
            if (!texture.isReadable || (texture.format != TextureFormat.RGBA32 && texture.format != TextureFormat.RGB24 &&
                texture.format != TextureFormat.ARGB32 && texture.format != TextureFormat.Alpha8))
            {
                product.issue = "unity-texture-png-unavailable";
                return;
            }
            var bytes = texture.EncodeToPNG();
            if (bytes == null || bytes.Length == 0) product.issue = "unity-texture-png-unavailable";
            else File.WriteAllBytes(Path.Combine(directory, product.number + ".png"), bytes);
        }

        private static void ExportMaterial(Material material, string directory, List<Product> products)
        {
            var product = new Product {
                role = "material", format = "json", name = material.name, number = products.Count
            };
            product.SetSource(material);
            products.Add(product);
            var bindings = new List<TextureBinding>();
            foreach (var property in material.GetTexturePropertyNames())
            {
                var texture = material.GetTexture(property);
                if (!texture || !AssetDatabase.TryGetGUIDAndLocalFileIdentifier(texture, out string guid, out long fileID)) continue;
                var scale = material.GetTextureScale(property);
                var offset = material.GetTextureOffset(property);
                bindings.Add(new TextureBinding {
                    property = property, guid = guid, fileID = fileID.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    scaleX = scale.x, scaleY = scale.y, offsetX = offset.x, offsetY = offset.y
                });
            }
            var data = new MaterialInfo { name = material.name, shader = material.shader ? material.shader.name : null, textures = bindings.ToArray() };
            File.WriteAllText(Path.Combine(directory, product.number + ".json"), JsonUtility.ToJson(data, true));
        }
    }
}
