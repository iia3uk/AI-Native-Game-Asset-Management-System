using AssetsTools.NET;
using AssetViewer.UnityBundle.Formats;
using AssetViewer.UnityBundle.Objects.Resources;

namespace AssetViewer.UnityBundle.Objects.Audio;

internal sealed record AudioInput(string Name, int Channels, int SampleRate, int BitsPerSample, int Subsound,
    ResourceReference External);

internal static class AudioClip
{
    public static Product Read(AssetTypeValueField field, string member, SerializedResources resources,
        bool inspectOnly, long outputLimit)
    {
        var source = field["m_Resource"];
        if (source.IsDummy) throw new BundleException("unity-bundle-audio-resource");
        return Read(new AudioInput(field["m_Name"].AsString, field["m_Channels"].AsInt, field["m_Frequency"].AsInt,
            field["m_BitsPerSample"].AsInt, field["m_SubsoundIndex"].AsInt,
            new ResourceReference(source["m_Source"].AsString, source["m_Offset"].AsULong, source["m_Size"].AsULong)),
            member, resources, inspectOnly, outputLimit);
    }

    public static Product Read(AudioInput input, string member, SerializedResources resources,
        bool inspectOnly, long outputLimit)
    {
        var resource = resources.ResolveAudio(member, input.External);
        var clip = FsbPcm.Read(resource);
        if (input.Subsound != 0 || input.Channels != clip.Channels ||
            input.SampleRate != clip.SampleRate || input.BitsPerSample != 16)
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
        var name = input.Name;
        return new Product(name.Length > 160 ? name[..160] : name, "wav", wave,
            Audio: new AudioSource(clip.Channels, clip.SampleRate, clip.Frames));
    }
}
