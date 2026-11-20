using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

// Launch a command inside a capability-free AppContainer. Only the disposable working
// copy and scratch directory are writable. The parent owns the only handle to the Job.
internal static class TaskHost {
    [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities {
        public IntPtr Sid, Capabilities; public uint Count, Reserved;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
        public int Size; public IntPtr Reserved, Desktop, Title;
        public int X,Y,XSize,YSize,XChars,YChars,Fill,Flags; public short Show,ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
        public StartupInfo Startup; public IntPtr Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread; public int ProcessId, ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinSet, MaxSet;
        public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public ulong ReadOps, WriteOps, OtherOps, Reads, Writes, Others;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,int count,out IntPtr sid);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits limits,int size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr bytes);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string image,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupInfoEx si,out ProcessInfo pi);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint ms);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr handle,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,int size,IntPtr written);

    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Grant(string directory, SecurityIdentifier sid, FileSystemRights rights) {
        var acl=Directory.GetAccessControl(directory);
        acl.AddAccessRule(new FileSystemAccessRule(sid,rights,InheritanceFlags.ObjectInherit|InheritanceFlags.ContainerInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.SetAccessControl(directory,acl);
    }
    static void Attribute(IntPtr list,int id,IntPtr value,int size) {
        Check(UpdateProcThreadAttribute(list,0,new IntPtr(id),value,new IntPtr(size),IntPtr.Zero,IntPtr.Zero));
    }
    static string EnvironmentBlock(string tmp,string runtime) {
        var vars=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        var sys=Environment.SystemDirectory; var windows=Directory.GetParent(sys).FullName;
        vars["SYSTEMROOT"]=vars["WINDIR"]=windows; vars["COMSPEC"]=Path.Combine(sys,"cmd.exe");
        vars["USERPROFILE"]=vars["APPDATA"]=vars["LOCALAPPDATA"]=vars["TEMP"]=vars["TMP"]=tmp;
        vars["PATH"]=runtime+";"+Environment.GetEnvironmentVariable("Path",EnvironmentVariableTarget.Machine);
        // Keep Node's module loader inside granted directories instead of statting volume ancestors.
        vars["NODE_OPTIONS"]="--preserve-symlinks --preserve-symlinks-main";
        vars["PATHEXT"]=".COM;.EXE;.BAT;.CMD"; vars["NODE_DISABLE_COLORS"]="1"; vars["NPM_CONFIG_OFFLINE"]="true";
        var result=new StringBuilder();foreach(var pair in vars)result.Append(pair.Key+"="+pair.Value+'\0');
        return result.ToString()+'\0';
    }
    static int Run(string[] args) {
        // The controller supplies all paths. Command text lives in the job's fixed batch file.
        var jobDir=Path.GetFullPath(args[0]); var profile="Anywhere.Task."+new Guid(Path.GetFileName(jobDir)).ToString("N");
        if(args.Length==1) {DeleteAppContainerProfile(profile);return 0;}
        var tree=Path.Combine(jobDir,"work"); var cwd=Path.GetFullPath(Path.Combine(tree,args[1]));
        if(cwd!=tree && !cwd.StartsWith(tree+@"\",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException();
        var runtime=Path.GetFullPath(args[2]); var temp=Path.Combine(jobDir,"temp"); Directory.CreateDirectory(temp);
        IntPtr sid=IntPtr.Zero, job=IntPtr.Zero, list=IntPtr.Zero, cap=IntPtr.Zero, jobList=IntPtr.Zero, handles=IntPtr.Zero, env=IntPtr.Zero;
        IntPtr owner=IntPtr.Zero; bool initialized=false; ProcessInfo pi=new ProcessInfo();
        try {
            owner=OpenProcess(0x100000,false,Int32.Parse(args[3]));Check(owner!=IntPtr.Zero);
            int hr=CreateAppContainerProfile(profile,profile,"Anywhere project task",IntPtr.Zero,0,out sid);
            if(hr==unchecked((int)0x800700B7))hr=DeriveAppContainerSidFromAppContainerName(profile,out sid);
            Marshal.ThrowExceptionForHR(hr);
            var identity=new SecurityIdentifier(sid);
            Grant(tree,identity,FileSystemRights.Modify|FileSystemRights.Synchronize);
            Grant(temp,identity,FileSystemRights.Modify|FileSystemRights.Synchronize);
            var batch=Path.Combine(jobDir,"task.cmd");var acl=File.GetAccessControl(batch);
            acl.AddAccessRule(new FileSystemAccessRule(identity,FileSystemRights.ReadAndExecute,AccessControlType.Allow));File.SetAccessControl(batch,acl);
            job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
            var limits=new ExtendedLimits();limits.Basic.Flags=0x2000|0x08|0x200; // kill on last handle, active processes, job memory
            limits.Basic.Active=64;limits.JobMemory=new UIntPtr(1073741824);
            Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)));
            var bytes=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,3,0,ref bytes);
            list=Marshal.AllocHGlobal(bytes);Check(InitializeProcThreadAttributeList(list,3,0,ref bytes));initialized=true;
            var caps=new SecurityCapabilities {Sid=sid};cap=Marshal.AllocHGlobal(Marshal.SizeOf(caps));Marshal.StructureToPtr(caps,cap,false);
            Attribute(list,0x20009,cap,Marshal.SizeOf(caps)); // SECURITY_CAPABILITIES, zero network capabilities
            jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,job);Attribute(list,0x2000D,jobList,IntPtr.Size);
            var io=new[]{GetStdHandle(-10),GetStdHandle(-11),GetStdHandle(-12)};
            handles=Marshal.AllocHGlobal(3*IntPtr.Size);
            for(int i=0;i<io.Length;i++){Check(SetHandleInformation(io[i],1,1));Marshal.WriteIntPtr(handles,i*IntPtr.Size,io[i]);}
            Attribute(list,0x20002,handles,3*IntPtr.Size);
            var si=new StartupInfoEx {Attributes=list};si.Startup.Size=Marshal.SizeOf(si);si.Startup.Flags=0x100;
            si.Startup.Input=io[0];si.Startup.Output=io[1];si.Startup.Error=io[2];
            string shell=Path.Combine(Environment.SystemDirectory,"cmd.exe");
            env=Marshal.StringToHGlobalUni(EnvironmentBlock(temp,runtime));
            var line=new StringBuilder("\""+shell+"\" /D /S /C \"\""+batch+"\"\"");
            Check(CreateProcess(shell,line,IntPtr.Zero,IntPtr.Zero,true,0x08000000|0x00080000|0x400,env,cwd,ref si,out pi));
            if(WaitForMultipleObjects(2,new[]{pi.Process,owner},false,120000)!=0)throw new TimeoutException();
            uint code;Check(GetExitCodeProcess(pi.Process,out code));
            // A batch may return while it still has children writing in the staging tree.
            Check(TerminateJobObject(job,1));
            IntPtr accounting=Marshal.AllocHGlobal(48);
            try {
                var clock=Stopwatch.StartNew();
                for(;;){Check(QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero));
                    if(Marshal.ReadInt32(accounting,40)==0)break;
                    if(clock.ElapsedMilliseconds>5000)throw new TimeoutException();
                    System.Threading.Thread.Sleep(20);}
            } finally {Marshal.FreeHGlobal(accounting);}
            File.WriteAllText(Path.Combine(jobDir,"exit-code"),unchecked((int)code).ToString());
            return unchecked((int)code);
        } finally {
            if(job!=IntPtr.Zero)CloseHandle(job);
            if(owner!=IntPtr.Zero)CloseHandle(owner);
            if(pi.Thread!=IntPtr.Zero)CloseHandle(pi.Thread);if(pi.Process!=IntPtr.Zero)CloseHandle(pi.Process);
            if(initialized)DeleteProcThreadAttributeList(list);
            foreach(var allocation in new[]{list,cap,jobList,handles,env})if(allocation!=IntPtr.Zero)Marshal.FreeHGlobal(allocation);
            if(sid!=IntPtr.Zero){FreeSid(sid);DeleteAppContainerProfile(profile);}
        }
    }
    static int Main(string[] args) {
        try {return Run(args);} catch(Exception error) {Console.Error.WriteLine("WINDOWS_SANDBOX_FAILED: "+error.Message);return 125;}
    }
}
