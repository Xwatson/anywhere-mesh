using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

// The desktop owns stdin. Its loss stops the peer. If this supervisor itself is
// terminated, the non-inherited Job handle closes and Windows stops the peer.
internal static class PeerHost {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static int Main(string[] args) {
        try {
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            // Keep this sole handle until process exit. Join before starting the peer,
            // so the peer belongs to the job from its very first instruction.
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero || !SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)) ||
                !AssignProcessToJobObject(job,Process.GetCurrentProcess().Handle)) return 1;
            string root = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA"), "AnywhereMesh");
            string executable = args.Length == 0 ? Path.Combine(root,@"runtime\easytier-core.exe") : args[0];
            bool managed = args.Length == 2 && args[1] == "session";
            if ((args.Length > 1 && !managed) || !Path.IsPathRooted(executable) || Path.GetFileName(executable) != "easytier-core.exe") return 1;
            var start = new ProcessStartInfo(executable) {
                Arguments = (managed ? "" : "--disable-env-parsing ") + "--config-file \"" +
                    Path.Combine(root, managed ? "network-session.toml" : "windows.toml") +
                    "\" --rpc-portal 127.0.0.1:" + (managed ? "0" : "31897") + " --console-log-level error",
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true
            };
            using (var peer = Process.Start(start)) {
                peer.StandardInput.Close();
                var disconnected = Task.Run(() => Console.OpenStandardInput().ReadByte());
                while (!disconnected.IsCompleted) if (peer.WaitForExit(150)) return peer.ExitCode;
                if (!peer.HasExited) { peer.Kill(); peer.WaitForExit(2000); }
                return 0;
            }
        } catch (Exception) { return 1; }
    }
}
