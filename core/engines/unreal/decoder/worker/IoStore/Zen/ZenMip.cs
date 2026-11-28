using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.IO.Objects;

namespace AssetViewer.UnrealDecode.IoStore.Zen;

internal sealed record ZenMip(int Width, int Height, int Depth, ZenBulkData Payload)
{
    public static ZenMip Read(FAssetArchive archive, FBulkDataMapEntry[] map, long end)
    {
        var payload = ZenBulkData.Read(archive, map, end - 12);
        return new(archive.Read<int>(), archive.Read<int>(), archive.Read<int>(), payload);
    }
}
