using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Every requested path is relative to a pinned directory on a fixed local volume.
internal sealed class WorkspacePath : IDisposable {
    [StructLayout(LayoutKind.Sequential)] internal struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Modified;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        public string Identity { get {return Volume.ToString("X8")+":"+IndexHigh.ToString("X8")+IndexLow.ToString("X8");} }
        public bool IsDirectory {get{return (Attributes&16)!=0;}}
        public long Size {get{return ((long)SizeHigh<<32)+SizeLow;}}
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder result,uint size,uint flags);
    [DllImport("kernel32.dll")] static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,ref int value,uint size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,IntPtr security);
    public const int TextLimit=1024*1024;
    public const int ImageLimit=5*1024*1024;
    public readonly string Root;
    public string Current;
    public Info Stat;
    readonly Stack<SafeFileHandle> held=new Stack<SafeFileHandle>();
    public static void Deny(string reason){throw new InvalidDataException(reason);}
    public static bool Missing(Win32Exception e){return e.NativeErrorCode==2||e.NativeErrorCode==3;}
    public WorkspacePath(string root,string identity) {
        if(!Regex.IsMatch(root,@"^[A-Za-z]:\\.+")||root!=Path.GetFullPath(root)||new DriveInfo(Path.GetPathRoot(root)).DriveType!=DriveType.Fixed)Deny("LOCAL_PROJECT_REQUIRED");
        Root=Current=root;
        try {held.Push(Open(root,true,0x80,3,out Stat));if(identity!=null && identity!=Stat.Identity)Deny("WORKSPACE_ROOT_CHANGED");}
        catch {Dispose();throw;}
    }
    SafeFileHandle Open(string path,bool? dir,uint access,uint creation,out Info info) {
        var handle=CreateFile(@"\\?\"+path,access,1,IntPtr.Zero,creation,0x02200000,IntPtr.Zero);
        if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
            if(GetFileType(handle)!=1||(info.Attributes&0x400)!=0||(dir.HasValue&&dir.Value!=info.IsDirectory))Deny("PATH_DENIED");
            if(!info.IsDirectory&&info.Links!=1)Deny("REGULAR_SINGLE_LINK_FILE_REQUIRED");
            var value=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(handle,value,(uint)value.Capacity,0);
            if(n==0||n>=value.Capacity||!String.Equals(value.ToString(),@"\\?\"+path,StringComparison.OrdinalIgnoreCase))
                Deny(path==Root?"WORKSPACE_ROOT_CHANGED":"PATH_DENIED");
            return handle;
        } catch {handle.Dispose();throw;}
    }
    public static string[] Parts(string path) {
        var parts=new List<string>();
        foreach(string name in path.Split('/')) {
            if(name==".")continue;
            if(name.Length==0||name.EndsWith(".")||name.EndsWith(" ")||name.IndexOf('\\')>=0||name.IndexOfAny(Path.GetInvalidFileNameChars())>=0||
                Regex.IsMatch(name,@"^(CON|CONIN\$|CONOUT\$|NUL|AUX|PRN|COM[0-9¹²³]|LPT[0-9¹²³])(\.|$)",RegexOptions.IgnoreCase))Deny("PATH_DENIED");
            parts.Add(name);
        }
        return parts.ToArray();
    }
    public void Enter(string[] parts,int count,bool create) {
        for(int i=0;i<count;i++){
            Current=Path.Combine(Current,parts[i]);
            try {held.Push(Open(Current,true,0x80,3,out Stat));}
            catch(Win32Exception e){
                if(!create||!Missing(e))throw;
                if(!CreateDirectory(@"\\?\"+Current,IntPtr.Zero)&&Marshal.GetLastWin32Error()!=183)throw new Win32Exception(Marshal.GetLastWin32Error());
                held.Push(Open(Current,true,0x80,3,out Stat));
            }
        }
    }
    public SafeFileHandle Leaf(string relative,bool? dir,uint access,uint creation) {
        var parts=Parts(relative);
        if(parts.Length==0){if(dir==false || creation!=3 || access!=0x80)Deny("PATH_DENIED");}
        else {Enter(parts,parts.Length-1,false);Current=Path.Combine(Current,parts[parts.Length-1]);}
        return Open(Current,dir,access,creation,out Stat);
    }
    public static byte[] Bytes(FileStream stream,long size,int limit){
        if(size>limit)Deny("FILE_SNAPSHOT_TOO_LARGE");
        var bytes=new byte[(int)size];int done=0;
        while(done<bytes.Length){int n=stream.Read(bytes,done,bytes.Length-done);if(n==0)Deny("FILE_CHANGED_DURING_READ");done+=n;}
        return bytes;
    }
    public byte[] Read(string path,int limit){
        using(var f=new FileStream(Leaf(path,false,0x80000000,3),FileAccess.Read))return Bytes(f,Stat.Size,limit);
    }
    public static string Revision(byte[] bytes){
        using(var h=SHA256.Create())return "file-v1:"+BitConverter.ToString(h.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
    }
    public void Write(string path,string expected,byte[] content,int limit) {
        if(content.Length>limit)Deny("FILE_SNAPSHOT_TOO_LARGE");
        bool fresh=expected=="absent";
        SafeFileHandle handle;
        try{handle=Leaf(path,false,0xC0000000|(fresh?0x10000U:0U),fresh?1U:3U);}
        catch(Win32Exception e){if((fresh&&(e.NativeErrorCode==80||e.NativeErrorCode==183))||(!fresh&&Missing(e)))Deny("FILE_VERSION_CONFLICT");throw;}
        using(var f=new FileStream(handle,FileAccess.ReadWrite)){
            byte[] prior=fresh?null:Bytes(f,Stat.Size,limit);
            if(!fresh&&Revision(prior)!=expected)Deny("FILE_VERSION_CONFLICT");
            try {ReplaceContents(f,content);}
            catch {
                try {if(fresh)MarkDeleted(handle);else ReplaceContents(f,prior);}
                catch {Deny("WORKSPACE_COMMIT_UNCERTAIN");}
                throw;
            }
        }
    }
    static void ReplaceContents(FileStream stream,byte[] bytes) {
        stream.Position=0;stream.Write(bytes,0,bytes.Length);stream.SetLength(bytes.Length);stream.Flush(true);
    }
    static void MarkDeleted(SafeFileHandle handle) {
        int yes=1;if(!SetFileInformationByHandle(handle,4,ref yes,4))throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public void Remove(string path,string expected,int limit) {
        bool directory=expected==WorkspaceTree.DirectoryMark;
        using(var h=Leaf(path,directory,directory?0x10080U:0x80010000U,3)){
            if(directory)MarkDeleted(h);
            else using(var f=new FileStream(h,FileAccess.Read)){
                if(Revision(Bytes(f,Stat.Size,limit))!=expected)Deny("FILE_VERSION_CONFLICT");
                MarkDeleted(h);
            }
        }
    }
    public void Dispose(){while(held.Count>0)held.Pop().Dispose();}
}

internal static class WorkspaceSnapshot {
    internal static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=32*1024*1024};
    internal static void Print(object value){Console.WriteLine(Json.Serialize(value));}
    static void Run(string[] a) {
        Console.OutputEncoding=new UTF8Encoding(false);
        using(var path=new WorkspacePath(a[0],a.Length==1?null:a[1])){
            if(a.Length==1){Console.WriteLine(path.Stat.Identity);return;}
            if(a.Length==3){
                byte[] raw=path.Read(a[2],WorkspacePath.TextLimit);
                using(var output=Console.OpenStandardOutput())output.Write(raw,0,raw.Length);
                return;
            }
            switch(a[2]){
            case "write":
                using(var input=Console.OpenStandardInput())using(var data=new MemoryStream()){
                    var buffer=new byte[16384];int n;while((n=input.Read(buffer,0,buffer.Length))>0){
                        data.Write(buffer,0,n);if(data.Length>WorkspacePath.TextLimit)WorkspacePath.Deny("FILE_SNAPSHOT_TOO_LARGE");}
                    path.Write(a[3],a[4],data.ToArray(),WorkspacePath.TextLimit);
                }break;
            case "remove": path.Remove(a[3],a[4],WorkspacePath.TextLimit);break;
            case "read-image": {
                byte[] raw=path.Read(a[3],WorkspacePath.ImageLimit);
                using(var output=Console.OpenStandardOutput())output.Write(raw,0,raw.Length);
                break;
            }
            case "mkdir":var parts=WorkspacePath.Parts(a[3]);path.Enter(parts,parts.Length,true);break;
            case "info":
                using(path.Leaf(a[3],null,0x80,3)){Print(new {directory=path.Stat.IsDirectory,size=path.Stat.Size});}break;
            case "list": WorkspaceTree.List(path,a[1],a[3],Int32.Parse(a[4]));break;
            case "search": WorkspaceTree.Search(path,a[1],a[3],a[4],a[5],a[6]=="true",Int32.Parse(a[7]));break;
            case "stage": WorkspaceTree.Stage(path.Root,a[1],a[3]);break;
            case "apply": WorkspaceTree.Apply(path.Root,a[1],a[3]);break;
            default:WorkspacePath.Deny("INVALID_ARGUMENTS");break;
            }
        }
    }
    static int Main(string[] args) {
        try{Run(args);return 0;}
        catch(InvalidDataException e){Console.Error.WriteLine(e.Message);return e.Message=="WORKSPACE_COMMIT_UNCERTAIN"?2:1;}
        catch(Win32Exception e){Console.Error.WriteLine(WorkspacePath.Missing(e)?"FILE_NOT_FOUND":"FILE_ACCESS_DENIED");}
        catch(Exception){Console.Error.WriteLine("WORKSPACE_OPERATION_FAILED");}
        return 1;
    }
}
