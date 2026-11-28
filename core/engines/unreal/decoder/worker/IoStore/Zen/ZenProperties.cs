using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Versions;

namespace AssetViewer.UnrealDecode.IoStore.Zen;

internal static class ZenProperties
{
    public static void Read(FAssetArchive archive, Action<FPropertyTag> visit)
    {
        if (archive.Ver >= EUnrealEngineObjectUE5Version.PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION &&
            archive.Read<byte>() != 0) throw new InputException("property-layout");
        for (var i = 0; i < 2048; i++)
        {
            if (archive.Ver >= EUnrealEngineObjectUE5Version.PROPERTY_TAG_COMPLETE_TYPE_NAME)
                BoundTypeName(archive);
            var tag = new FPropertyTag(archive, false);
            if (tag.Name.IsNone) return;
            if (tag.Size < 0 || tag.Size > archive.Length - archive.Position) throw ZenPackage.Invalid();
            var end = archive.Position + tag.Size;
            visit(tag);
            if (archive.Position > end) throw ZenPackage.Invalid();
            archive.Position = end;
        }
        throw ZenPackage.Invalid();
    }

    private static void BoundTypeName(FAssetArchive archive)
    {
        var start = archive.Position;
        if (!archive.ReadFName().IsNone)
        {
            var pending = 1;
            for (var i = 0; pending > 0; i++)
            {
                if (i >= 32) throw ZenPackage.Invalid();
                _ = archive.ReadFName();
                var children = archive.Read<int>();
                if (children < 0 || children > 32 - i - pending) throw ZenPackage.Invalid();
                pending += children - 1;
            }
        }
        archive.Position = start;
    }

    public static bool TaggedBoolean(FPropertyTag tag) =>
        tag.PropertyType.Text == "BoolProperty" && tag.ArrayIndex == 0 && tag.Size == 0 &&
        tag.SerializeType == EPropertyTagSerializeType.Property && tag.TagData?.Bool is bool value
            ? value : throw ZenPackage.Invalid();

    public static bool Boolean(FAssetArchive archive) => archive.Read<int>() switch
    {
        0 => false,
        1 => true,
        _ => throw ZenPackage.Invalid(),
    };
}
