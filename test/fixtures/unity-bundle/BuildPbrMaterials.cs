using System;
using System.IO;
using UnityEditor;
using UnityEngine;

internal static partial class BundleFixtureMaterials
{
    public static string[] CreatePbr(string root, Mesh source)
    {
        root += "/PbrMaterials";
        Directory.CreateDirectory(root);
        AssetDatabase.Refresh();
        var shader = Shader.Find("Standard");
        var metal = SaveMaterial(root, shader, "PbrMetal", new Color32(73, 99, 145, 151));
        Sampling((Texture2D)metal.mainTexture);
        var packed = Map(root, "PbrMetallicGloss", new Color32(37, 18, 208, 180), true);
        var ao = Map(root, "PbrOcclusion", new Color32(231, 61, 145, 101), true);
        var emission = Map(root, "PbrEmission", new Color32(23, 147, 91, 255), false);
        var normal = Map(root, "PbrPackedNormal", new Color32(255, 165, 0, 155), true, true);
        metal.SetTexture("_MetallicGlossMap", packed);
        metal.SetTexture("_OcclusionMap", ao);
        metal.SetTexture("_BumpMap", normal);
        metal.SetTexture("_EmissionMap", emission);
        metal.EnableKeyword("_METALLICGLOSSMAP");
        metal.EnableKeyword("_NORMALMAP");
        metal.EnableKeyword("_EMISSION");
        metal.SetFloat("_GlossMapScale", .5f);
        metal.SetFloat("_OcclusionStrength", .25f);
        metal.SetFloat("_BumpScale", 1.25f);
        metal.SetColor("_EmissionColor", new Color(2, .5f, .25f, 1));
        metal.SetTextureScale("_MainTex", new Vector2(2, .5f));
        metal.SetTextureOffset("_MainTex", new Vector2(.125f, .25f));
        // Standard takes its primary maps through the _MainTex transform.
        metal.SetTextureScale("_OcclusionMap", new Vector2(3, 4));
        EditorUtility.SetDirty(metal);

        var alpha = SaveMaterial(root, shader, "PbrAlbedoAlpha", new Color32(110, 121, 138, 96));
        Sampling((Texture2D)alpha.mainTexture);
        alpha.SetTexture("_MetallicGlossMap", packed);
        alpha.SetFloat("_GlossMapScale", .75f);
        alpha.SetFloat("_SmoothnessTextureChannel", 1);
        alpha.SetFloat("_Mode", 1);
        alpha.SetFloat("_Cutoff", .45f);
        alpha.EnableKeyword("_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A");
        alpha.EnableKeyword("_METALLICGLOSSMAP");
        alpha.EnableKeyword("_ALPHATEST_ON");
        EditorUtility.SetDirty(alpha);

        var mismatch = SaveMaterial(root, shader, "PbrMismatch", new Color32(110, 121, 138, 96));
        mismatch.SetTexture("_MetallicGlossMap", packed);
        mismatch.SetFloat("_SmoothnessTextureChannel", 1);
        mismatch.EnableKeyword("_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A");
        mismatch.EnableKeyword("_METALLICGLOSSMAP");
        // Authored but disabled. The importer should preserve the reference without applying it.
        mismatch.SetTexture("_EmissionMap", emission);
        EditorUtility.SetDirty(mismatch);

        var mesh = SaveMesh(root, source, "PbrMesh");
        mesh.RecalculateTangents();
        EditorUtility.SetDirty(mesh);
        var unmatched = SaveMesh(root, mesh, "PbrMismatchMesh");
        return new[] { SavePrefab(root, "PbrModel", mesh, metal, alpha), SavePrefab(root, "PbrMismatchModel", unmatched, mismatch, mismatch) };
    }

    private static Texture2D Map(string root, string name, Color32 color, bool linear, bool compress = false)
    {
        var texture = new Texture2D(4, 4, TextureFormat.RGBA32, false, linear) { name = name };
        var colors = new Color32[16];
        Array.Fill(colors, color);
        texture.SetPixels32(colors);
        texture.Apply();
        if (compress)
        {
            texture.Compress(true);
            if (texture.format != TextureFormat.DXT5) throw new InvalidOperationException("Expected a DXT5 normal map.");
        }
        Sampling(texture);
        AssetDatabase.CreateAsset(texture, root + "/" + name + ".asset");
        return texture;
    }

    private static void Sampling(Texture2D texture)
    {
        texture.filterMode = FilterMode.Point;
        texture.wrapModeU = TextureWrapMode.Clamp;
        texture.wrapModeV = TextureWrapMode.Mirror;
        texture.anisoLevel = 1;
        EditorUtility.SetDirty(texture);
    }
}
