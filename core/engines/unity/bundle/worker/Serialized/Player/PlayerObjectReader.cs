using System.Buffers.Binary;
using System.Text;

namespace AssetViewer.UnityBundle.Serialized.Player;

internal struct PlayerObjectReader(ReadOnlyMemory<byte> bytes)
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private int position;

    public int Int32() => BinaryPrimitives.ReadInt32LittleEndian(Take(4).Span);
    public uint UInt32() => BinaryPrimitives.ReadUInt32LittleEndian(Take(4).Span);
    public ulong UInt64() => BinaryPrimitives.ReadUInt64LittleEndian(Take(8).Span);

    public void Skip(int length) => Take(length);
    public void Align() => Skip((4 - position % 4) % 4);

    public ReadOnlyMemory<byte> Bytes()
    {
        var data = Take(Int32());
        Align();
        return data;
    }

    public string String(int maximumBytes)
    {
        var data = Bytes();
        if (data.Length > maximumBytes) throw new BundleException("unity-bundle-object-invalid");
        return Utf8.GetString(data.Span);
    }

    public void RequireEnd()
    {
        if (position != bytes.Length) throw new BundleException("unity-bundle-object-invalid");
    }

    private ReadOnlyMemory<byte> Take(int length)
    {
        if (length < 0 || length > bytes.Length - position)
            throw new BundleException("unity-bundle-object-invalid");
        var data = bytes.Slice(position, length);
        position += length;
        return data;
    }
}
