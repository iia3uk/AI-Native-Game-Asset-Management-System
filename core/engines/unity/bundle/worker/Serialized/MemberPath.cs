using System.Text.RegularExpressions;

namespace AssetViewer.UnityBundle.Serialized;

internal sealed record MemberPath(string? Mount, string Name)
{
    private static readonly Regex Archive = new(
        @"\Aarchive:/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Flat = new(@"\A[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\z");

    public static MemberPath? Read(string? path)
    {
        if (path is not { Length: > 0 and <= 250 }) return null;
        var archive = Archive.Match(path);
        if (archive.Success) return new MemberPath(archive.Groups[1].Value, archive.Groups[2].Value);
        return Flat.IsMatch(path) ? new MemberPath(null, path) : null;
    }
}
