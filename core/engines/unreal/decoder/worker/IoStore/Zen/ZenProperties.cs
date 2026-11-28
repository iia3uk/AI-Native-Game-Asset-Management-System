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
        ReadTags(archive, archive.Length, visit);
    }

    public static void ReadTags(FAssetArchive archive, long boundary, Action<FPropertyTag> visit)
    {
        for (var i = 0; i < 2048 && archive.Position + 8 <= boundary; i++)
        {
            var tag = ReadTag(archive);
            if (archive.Position > boundary || tag.Size < 0 || tag.Size > boundary - archive.Position) throw ZenPackage.Invalid();
            if (tag.Name.IsNone) return;
            var end = archive.Position + tag.Size;
            visit(tag);
            if (archive.Position > end) throw ZenPackage.Invalid();
            archive.Position = end;
        }
        throw ZenPackage.Invalid();
    }

    private static FPropertyTag ReadTag(FAssetArchive archive)
    {
        if (archive.Ver >= EUnrealEngineObjectUE5Version.PROPERTY_TAG_COMPLETE_TYPE_NAME)
            BoundTypeName(archive);
        return new FPropertyTag(archive, false);
    }

    public static T[] StructArray<T>(FAssetArchive archive, FPropertyTag tag, string type, Func<long, T> element)
    {
        if (tag.PropertyType.Text != "ArrayProperty" || tag.TagData?.InnerType != "StructProperty" ||
            tag.ArrayIndex != 0 || tag.Size < 4) throw ZenPackage.Invalid();
        var boundary = archive.Position + tag.Size;
        var count = archive.Read<int>();
        if (count is < 0 or > 256) throw new InputException("property-count");
        if (count == 0 && archive.Position == boundary) return [];
        if (archive.Ver >= EUnrealEngineObjectUE5Version.PROPERTY_TAG_COMPLETE_TYPE_NAME)
        {
            if (tag.TagData.InnerTypeData?.StructType != type) throw ZenPackage.Invalid();
        }
        else
        {
            var inner = ReadTag(archive);
            if (inner.Name.Text != tag.Name.Text || inner.PropertyType.Text != "StructProperty" || inner.TagData?.StructType != type ||
                inner.Size != boundary - archive.Position) throw ZenPackage.Invalid();
        }
        if (count * 8 > boundary - archive.Position) throw ZenPackage.Invalid();
        var result = new T[count];
        for (var i = 0; i < count; i++) result[i] = element(boundary);
        if (archive.Position != boundary) throw ZenPackage.Invalid();
        return result;
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
