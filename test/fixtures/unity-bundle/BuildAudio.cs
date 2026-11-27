using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

internal static class BundleFixtureAudio
{
    public static string[] Create(string root) => new[] {
        SaveClip(root, "MonoPcm", 22050, 1, 1001, AudioCompressionFormat.PCM, AudioClipLoadType.DecompressOnLoad),
        SaveClip(root, "StereoPcm", 48000, 2, 2309, AudioCompressionFormat.PCM, AudioClipLoadType.Streaming),
        SaveClip(root, "StereoVorbis", 44100, 2, 10000, AudioCompressionFormat.Vorbis, AudioClipLoadType.CompressedInMemory),
    };

    private static string SaveClip(string root, string name, int rate, int channels, int frames,
        AudioCompressionFormat encoding, AudioClipLoadType loadType)
    {
        var path = root + "/" + name + ".wav";
        var bytes = frames * channels * sizeof(short);
        using (var output = new BinaryWriter(File.Create(path)))
        {
            output.Write(Encoding.ASCII.GetBytes("RIFF"));
            output.Write(36 + bytes);
            output.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
            output.Write(16);
            output.Write((short)1);
            output.Write((short)channels);
            output.Write(rate);
            output.Write(rate * channels * sizeof(short));
            output.Write((short)(channels * sizeof(short)));
            output.Write((short)16);
            output.Write(Encoding.ASCII.GetBytes("data"));
            output.Write(bytes);
            for (int frame = 0; frame < frames; frame++)
                for (int channel = 0; channel < channels; channel++)
                    output.Write((short)(((frame * (341 + channel * 23)) % 16000) - 8000 + (channel * 97)));
        }
        AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
        var importer = (AudioImporter)AssetImporter.GetAtPath(path);
        importer.defaultSampleSettings = new AudioImporterSampleSettings
        {
            compressionFormat = encoding,
            loadType = loadType,
            sampleRateSetting = AudioSampleRateSetting.PreserveSampleRate,
            quality = 0.8f,
        };
        importer.SaveAndReimport();
        return path;
    }
}
