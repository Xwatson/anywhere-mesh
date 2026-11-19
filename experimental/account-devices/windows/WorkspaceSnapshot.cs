using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

// Read one local file from the same handle we checked. No tool-controlled command is executed.
internal static class WorkspaceSnapshot {
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        public string Identity { get { return Volume.ToString("X8") + ":" + IndexHigh.ToString("X8") + IndexLow.ToString("X8"); } }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder path, uint capacity, uint flags);
    [DllImport("kernel32.dll")]
    static extern uint GetFileType(SafeFileHandle h);

    static void Refuse(string code) { throw new InvalidDataException(code); }
    static string FinalPath(SafeFileHandle h) {
        var s = new StringBuilder(32768);
        uint n = GetFinalPathNameByHandle(h, s, (uint)s.Capacity, 0);
        if (n == 0 || n >= s.Capacity) Refuse("PATH_DENIED");
        return s.ToString();
    }
    static SafeFileHandle Pin(string path, bool directory, out FileInfo info) {
        // OPEN_REPARSE_POINT | BACKUP_SEMANTICS. Deny writes and renames while the chain is pinned.
        var h = CreateFile(@"\\?\" + path, directory ? 0x80U : 0x80000000U, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            if (!GetFileInformationByHandle(h, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (GetFileType(h) != 1 || (info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory)
                Refuse("PATH_DENIED");
            if (!directory && info.Links != 1) Refuse("REGULAR_SINGLE_LINK_FILE_REQUIRED");
            return h;
        } catch { h.Dispose(); throw; }
    }

    static void Run(string[] args) {
        if (args.Length != 1 && args.Length != 3) Refuse("INVALID_ARGUMENTS");
        var root = args[0];
        if (!Regex.IsMatch(root, @"^[A-Za-z]:\\.+") || root != Path.GetFullPath(root) ||
            new DriveInfo(Path.GetPathRoot(root)).DriveType != DriveType.Fixed) Refuse("LOCAL_PROJECT_REQUIRED");
        var held = new Stack<SafeFileHandle>();
        try {
            FileInfo info;
            var dir = Pin(root, true, out info);
            held.Push(dir);
            string canonical = FinalPath(dir);
            if (!String.Equals(canonical, @"\\?\" + root, StringComparison.OrdinalIgnoreCase)) Refuse("WORKSPACE_ROOT_CHANGED");
            if (args.Length == 1) { Console.WriteLine(info.Identity); return; }
            if (args[1] != info.Identity) Refuse("WORKSPACE_ROOT_CHANGED");

            var parts = args[2].Split('/');
            string path = root;
            for (int i = 0; i < parts.Length; i++) {
                string part = parts[i];
                bool last = i == parts.Length - 1;
                if (!last && part == ".") continue;
                if (part.Length == 0 || part.EndsWith(".") || part.EndsWith(" ") || part.IndexOf('\\') >= 0 ||
                    part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                    Regex.IsMatch(part, @"^(CON|NUL|AUX|PRN|COM[0-9¹²³]|LPT[0-9¹²³])(\.|$)", RegexOptions.IgnoreCase))
                    Refuse("PATH_DENIED");
                path = Path.Combine(path, part);
                var h = Pin(path, !last, out info);
                held.Push(h);
                if (!FinalPath(h).StartsWith(canonical + @"\", StringComparison.Ordinal)) Refuse("PATH_DENIED");
                if (!last) continue;
                if (info.SizeHigh != 0 || info.SizeLow > 1024 * 1024) Refuse("FILE_SNAPSHOT_TOO_LARGE");
                using (var input = new FileStream(h, FileAccess.Read))
                using (var output = Console.OpenStandardOutput()) { input.CopyTo(output); }
            }
        } finally { while (held.Count > 0) held.Pop().Dispose(); }
    }
    static int Main(string[] args) {
        try { Run(args); return 0; }
        catch (InvalidDataException e) { Console.Error.WriteLine(e.Message); }
        catch (Win32Exception e) {
            Console.Error.WriteLine(e.NativeErrorCode == 2 || e.NativeErrorCode == 3 ? "FILE_NOT_FOUND" : "FILE_ACCESS_DENIED");
        }
        catch (Exception) { Console.Error.WriteLine("FILE_READ_FAILED"); }
        return 1;
    }
}
