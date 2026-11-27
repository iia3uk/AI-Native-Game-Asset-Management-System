using System;
using System.Globalization;
using UnityEditor;

namespace AssetViewerBridge
{
    [Serializable] internal sealed class Request { public Target[] targets; }
    [Serializable] internal sealed class Target { public string id; public string path; public string kind; }
    [Serializable] internal sealed class Response
    {
        public string editorVersion;
        public string exporterVersion;
        public Result[] results;
    }
    [Serializable] internal sealed class Result { public string id; public string issue; public Product[] products; }
    [Serializable] internal sealed class Product
    {
        public string role;
        public string format;
        public string name;
        public string guid;
        public string fileID;
        public string nodePath;
        public int number;
        public int triangles;
        public int width;
        public int height;
        public string colorSpace;
        public string issue;

        internal void SetSource(UnityEngine.Object source)
        {
            if (!source || !AssetDatabase.TryGetGUIDAndLocalFileIdentifier(source, out string sourceGuid, out long localID)) return;
            guid = sourceGuid;
            fileID = localID.ToString(CultureInfo.InvariantCulture);
        }
    }
    [Serializable] internal sealed class TextureBinding
    {
        public string property;
        public string guid;
        public string fileID;
        public float scaleX, scaleY, offsetX, offsetY;
    }
    [Serializable] internal sealed class MaterialInfo
    {
        public string name;
        public string shader;
        public TextureBinding[] textures;
    }
}
