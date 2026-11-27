using System.Buffers.Binary;
using AssetViewer.UnityBundle.UnityFs;

namespace AssetViewer.UnityBundle.Objects.Audio;

internal readonly record struct FsbPcm(int Channels, int SampleRate, int Frames, long DataOffset)
{
    private const int MainHeaderSize = 60;
    private static readonly int[] Rates = [4000, 8000, 11000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
    public long DataBytes => (long)Channels * Frames * sizeof(short);

    public static FsbPcm Read(ResourceSlice resource)
    {
        if (resource.Length < MainHeaderSize + sizeof(ulong))
            throw new BundleException("unity-bundle-audio-bank-size");
        Span<byte> header = stackalloc byte[MainHeaderSize + sizeof(ulong)];
        resource.Read(0, header);
        if (!header[..4].SequenceEqual("FSB5"u8) || BinaryPrimitives.ReadUInt32LittleEndian(header[4..]) != 1)
            throw new BundleException("unity-bundle-audio-bank-format");
        if (BinaryPrimitives.ReadUInt32LittleEndian(header[24..]) != 2)
            throw new BundleException("unity-bundle-audio-codec");
        if (BinaryPrimitives.ReadUInt32LittleEndian(header[8..]) != 1 ||
            BinaryPrimitives.ReadUInt64LittleEndian(header[28..]) != 0)
            throw new BundleException("unity-bundle-audio-bank-layout");

        var records = BinaryPrimitives.ReadUInt32LittleEndian(header[12..]);
        var names = BinaryPrimitives.ReadUInt32LittleEndian(header[16..]);
        var sourceBytes = BinaryPrimitives.ReadUInt32LittleEndian(header[20..]);
        var data = MainHeaderSize + (long)records + names;
        if (records < sizeof(ulong) || data + sourceBytes != resource.Length)
            throw new BundleException("unity-bundle-audio-bank-size");
        var sample = BinaryPrimitives.ReadUInt64LittleEndian(header[MainHeaderSize..]);
        var channels = 1 + (int)((sample >> 5) & 3);
        var rateCode = (int)((sample >> 1) & 15);
        var frames = (int)(sample >> 34);
        if ((sample & 1) != 0 || ((sample >> 7) & 0x7ffffff) != 0 || channels > 2 || rateCode >= Rates.Length)
            throw new BundleException("unity-bundle-audio-bank-layout");
        var clip = new FsbPcm(channels, Rates[rateCode], frames, data);
        if (frames < 1 || clip.DataBytes > sourceBytes)
            throw new BundleException("unity-bundle-audio-bank-size");
        return clip;
    }
}
