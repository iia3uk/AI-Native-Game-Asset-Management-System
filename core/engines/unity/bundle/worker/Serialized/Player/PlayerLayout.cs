using AssetsTools.NET;
using AssetViewer.UnityBundle.Objects.Audio;
using AssetViewer.UnityBundle.Objects.Resources;
using AssetViewer.UnityBundle.Objects.Textures;

namespace AssetViewer.UnityBundle.Serialized.Player;

internal static class PlayerLayout
{
    private const int StandaloneWindows64 = 19;

    // Windows player layouts verified against AssetBundles and Player data produced by both editors.
    public static bool Supports(AssetsFile file) =>
        file.Metadata.TargetPlatform == StandaloneWindows64 &&
        file.Metadata.UnityVersion is "6000.3.10f1" or "6000.6.0f1";

    public static bool Matches(AssetsFile file, AssetFileInfo info, int classId)
    {
        var expected = classId switch
        {
            28 => "b55819307006ed40e7e0f5f45a50c015",
            83 => "57a6370a001d5449abd37c2184ec5138",
            _ => null,
        };
        var type = file.Metadata.TypeTreeTypes[info.TypeIdOrIndex];
        return expected != null && !type.IsStrippedType && type.TypeHash.ToString() == expected;
    }

    public static PlayerObjectReader Open(AssetsFile file, AssetFileInfo info)
    {
        var offset = info.GetAbsoluteByteOffset(file);
        if (offset % 4 != 0) throw new BundleException("unity-bundle-object-invalid");
        var data = new byte[info.ByteSize];
        file.Reader.Position = offset;
        file.Reader.BaseStream.ReadExactly(data);
        return new PlayerObjectReader(data);
    }

    public static TextureInput ReadTexture(ref PlayerObjectReader reader, string name)
    {
        reader.Skip(1); // m_IsAlphaChannelOptional
        reader.Align();
        var width = reader.Int32();
        var height = reader.Int32();
        reader.Skip(8); // m_CompleteImageSize, m_MipsStripped
        var format = reader.Int32();
        reader.Skip(7); // m_MipCount, m_IsReadable, m_IsPreProcessed, m_IgnoreMipmapLimit
        reader.Align();
        reader.Bytes(); // m_MipmapLimitGroupName
        reader.Skip(1); // m_StreamingMipmaps
        reader.Align();
        reader.Skip(4); // m_StreamingMipmapsPriority
        var count = reader.Int32();
        var dimension = reader.Int32();
        reader.Skip(28); // m_TextureSettings, m_LightmapFormat
        var colorSpace = reader.Int32();
        reader.Bytes(); // m_PlatformBlob
        var data = reader.Bytes();
        var offset = reader.UInt64();
        var size = reader.UInt32();
        var path = reader.String(1024);
        reader.RequireEnd();
        return new TextureInput(name, width, height, dimension, count, format, colorSpace, data,
            new ResourceReference(path, offset, size));
    }

    public static AudioInput ReadAudio(ref PlayerObjectReader reader, string name)
    {
        reader.Skip(4); // m_LoadType
        var channels = reader.Int32();
        var sampleRate = reader.Int32();
        var bitsPerSample = reader.Int32();
        reader.Skip(6); // m_Length, m_IsTrackerFormat, m_Ambisonic
        reader.Align();
        var subsound = reader.Int32();
        reader.Skip(3); // m_PreloadAudioData, m_LoadInBackground, m_Legacy3D
        reader.Align();
        var path = reader.String(1024);
        var source = new ResourceReference(path, reader.UInt64(), reader.UInt64());
        reader.Skip(4); // m_CompressionFormat
        reader.RequireEnd();
        return new AudioInput(name, channels, sampleRate, bitsPerSample, subsound, source);
    }
}
