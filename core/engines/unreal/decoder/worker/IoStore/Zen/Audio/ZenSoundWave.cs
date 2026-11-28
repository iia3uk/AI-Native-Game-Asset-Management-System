using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Readers;
using AssetViewer.UnrealDecode.Objects.Audio;

namespace AssetViewer.UnrealDecode.IoStore.Zen.Audio;

internal static class ZenSoundWave
{
    public static (byte[] Bytes, string Format) Read(byte[] bytes, ZenPackage package,
        IReadOnlyDictionary<string, string> sidecars, long remaining)
    {
        using var source = new FByteArchive("SoundWave", bytes, package.Version);
        using var archive = new FAssetArchive(source, package);
        return SoundWaveLayout.Read(archive, remaining, end =>
        {
            var payload = ZenBulkData.Read(archive, package.Bulk, end);
            return new AudioBulkSlice(payload.Size, length =>
                payload.ReadBytes(bytes, sidecars, length) ?? throw new InputException("bulk-unavailable"));
        });
    }
}
