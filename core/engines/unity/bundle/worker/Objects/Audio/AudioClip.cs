using AssetsTools.NET;
using AssetViewer.UnityBundle.Formats;
using AssetViewer.UnityBundle.Objects.Resources;

namespace AssetViewer.UnityBundle.Objects.Audio;

internal static class AudioClip
{
    public static Product Read(AssetTypeValueField field, string member, SerializedResources resources,
        bool inspectOnly, long outputLimit)
    {
        var source = field["m_Resource"];
        if (source.IsDummy) throw new BundleException("unity-bundle-audio-resource");
        var resource = resources.ResolveAudio(member, source["m_Source"].AsString,
            source["m_Offset"].AsULong, source["m_Size"].AsULong);
        var clip = FsbPcm.Read(resource);
        if (field["m_SubsoundIndex"].AsInt != 0 || field["m_Channels"].AsInt != clip.Channels ||
            field["m_Frequency"].AsInt != clip.SampleRate || field["m_BitsPerSample"].AsInt != 16)
            throw new BundleException("unity-bundle-audio-metadata");

        var length = clip.DataBytes + PcmWave.HeaderSize;
        if (length > 32L << 20)
            throw new BundleException("unity-bundle-audio-size");
        byte[] wave = [];
        if (!inspectOnly)
        {
            if (length > outputLimit) throw new BundleException("unity-bundle-output-limit");
            wave = new byte[(int)length];
            PcmWave.WriteHeader(wave, clip.Channels, clip.SampleRate, (int)clip.DataBytes);
            resource.Read(clip.DataOffset, wave.AsSpan(PcmWave.HeaderSize));
        }
        var name = field["m_Name"].AsString;
        return new Product(name.Length > 160 ? name[..160] : name, "wav", wave,
            Audio: new AudioSource(clip.Channels, clip.SampleRate, clip.Frames));
    }
}
