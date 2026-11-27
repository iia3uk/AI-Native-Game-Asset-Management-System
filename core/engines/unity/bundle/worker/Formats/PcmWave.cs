using System.Buffers.Binary;

namespace AssetViewer.UnityBundle.Formats;

internal static class PcmWave
{
    public const int HeaderSize = 44;

    public static void WriteHeader(Span<byte> wave, int channels, int sampleRate, int bytes)
    {
        var frameSize = (ushort)(channels * sizeof(short));
        "RIFF"u8.CopyTo(wave);
        BinaryPrimitives.WriteInt32LittleEndian(wave[4..], bytes + HeaderSize - 8);
        "WAVEfmt "u8.CopyTo(wave[8..]);
        BinaryPrimitives.WriteInt32LittleEndian(wave[16..], 16);
        BinaryPrimitives.WriteUInt16LittleEndian(wave[20..], 1);
        BinaryPrimitives.WriteUInt16LittleEndian(wave[22..], (ushort)channels);
        BinaryPrimitives.WriteInt32LittleEndian(wave[24..], sampleRate);
        BinaryPrimitives.WriteInt32LittleEndian(wave[28..], sampleRate * frameSize);
        BinaryPrimitives.WriteUInt16LittleEndian(wave[32..], frameSize);
        BinaryPrimitives.WriteUInt16LittleEndian(wave[34..], 16);
        "data"u8.CopyTo(wave[36..]);
        BinaryPrimitives.WriteInt32LittleEndian(wave[40..], bytes);
    }
}
