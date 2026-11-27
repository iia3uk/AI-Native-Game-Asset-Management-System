namespace AssetViewer.UnrealDecode.Pak;

internal static class PakPaths
{
    private static readonly HashSet<string> WindowsDevices = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³"
    };

    public static string Check(string name)
    {
        if (name.Length is < 1 or > 768) throw new InputException("unreal-pak-path");
        var components = name.Split('/');
        if (components.Length > 24) throw new InputException("unreal-pak-path");
        foreach (var part in components)
        {
            if (part.Length is < 1 or > 120 || part is "." or ".." ||
                part.EndsWith('.') || part.EndsWith(' ') ||
                part.Any(c => char.IsControl(c) || "<>:\"\\|?*".Contains(c)) ||
                WindowsDevices.Contains(part.Split('.', 2)[0]))
                throw new InputException("unreal-pak-path");
        }
        return name;
    }
}
