using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

internal static class WorkspaceTree {
    public const string DirectoryMark="directory";
    const int FileLimit=64*1024*1024, EntryLimit=30000;
    const long TreeLimit=512L*1024*1024;
    static readonly StringComparer Names=StringComparer.OrdinalIgnoreCase;
    sealed class Bounded : Exception {}
    sealed class Budget {public int Count;public long Bytes;}
    delegate void Visit(string path,bool dir,long size);
    static void Walk(string root,string identity,string relative,int depth,bool strict,Budget budget,Visit visit){
        using(var parent=new WorkspacePath(root,identity)){
            var parts=WorkspacePath.Parts(relative);parent.Enter(parts,parts.Length,false);
            foreach(string item in Directory.EnumerateFileSystemEntries(parent.Current)){
                if(++budget.Count>EntryLimit){if(strict)WorkspacePath.Deny("WORKSPACE_TREE_LIMIT");throw new Bounded();}
                string name=Path.GetFileName(item), path=relative=="."?name:relative+"/"+name;
                bool dir;long size;
                using(var child=new WorkspacePath(root,identity)){
                    try{using(child.Leaf(path,null,0x80,3)){dir=child.Stat.IsDirectory;size=child.Stat.Size;}}
                    catch(InvalidDataException){if(strict)throw;continue;}
                    catch(Win32Exception){if(strict)throw;continue;}
                }
                visit(path,dir,size);
                if(dir&&depth>1)Walk(root,identity,path,depth-1,strict,budget,visit);
                if(dir&&depth==1&&strict)WorkspacePath.Deny("WORKSPACE_TREE_LIMIT");
            }
        }
    }
    public static void List(WorkspacePath root,string id,string rel,int depth){
        var names=new List<string>();bool truncated=false;
        try{Walk(root.Root,id,rel,depth,false,new Budget(),delegate(string p,bool d,long n){
            if(names.Count>=256)throw new Bounded();names.Add((d?"[DIR] ":"[FILE] ")+p);
        });}catch(Bounded){truncated=true;}
        WorkspaceSnapshot.Print(new {entries=names,truncated=truncated});
    }
    public static void Search(WorkspacePath root,string id,string rel,string type,string pattern,bool literal,int max){
        var matches=new List<string>();bool truncated=false;Regex regex=null;
        if(!literal){try{regex=new Regex(pattern,RegexOptions.IgnoreCase|RegexOptions.CultureInvariant,TimeSpan.FromMilliseconds(60));}
            catch(ArgumentException){WorkspacePath.Deny("INVALID_SEARCH_PATTERN");}}
        Predicate<string> hit=s=>literal?s.IndexOf(pattern,StringComparison.OrdinalIgnoreCase)>=0:regex.IsMatch(s);
        Action<string> add=s=>{if(matches.Count>=max)throw new Bounded();matches.Add(s);};
        var budget=new Budget();
        Visit search=delegate(string p,bool d,long size){
            if(type=="files"){if(hit(Path.GetFileName(p)))add(p);return;}
            if(d||size>WorkspacePath.TextLimit)return;
            budget.Bytes+=size;if(budget.Bytes>64L*1024*1024)throw new Bounded();
            using(var file=new WorkspacePath(root.Root,id)){
                string text;
                try{text=new UTF8Encoding(false,true).GetString(file.Read(p,WorkspacePath.TextLimit));}
                catch(DecoderFallbackException){return;}catch(Win32Exception){return;}
                if(text.IndexOf('\0')>=0)return;
                using(var lines=new StringReader(text)){string line;int number=0;while((line=lines.ReadLine())!=null){
                    number++;if(hit(line))add(p+":"+number+": "+line.Substring(0,Math.Min(240,line.Length)));
                }}
            }
        };
        try {
            bool directory;long size;
            using(var probe=new WorkspacePath(root.Root,id))using(probe.Leaf(rel,null,0x80,3)){directory=probe.Stat.IsDirectory;size=probe.Stat.Size;}
            if(directory)Walk(root.Root,id,rel,64,false,budget,search);else search(rel,false,size);
        } catch(Bounded){truncated=true;}catch(RegexMatchTimeoutException){WorkspacePath.Deny("SEARCH_PATTERN_TIMEOUT");}
        WorkspaceSnapshot.Print(new {entries=matches,truncated=truncated});
    }
    static Dictionary<string,string> Scan(string root,string identity,string copy){
        var manifest=new Dictionary<string,string>(Names);var budget=new Budget();
        Walk(root,identity,".",96,true,budget,delegate(string p,bool dir,long size){
            if(manifest.ContainsKey(p))WorkspacePath.Deny("AMBIGUOUS_PATH");
            string to=copy==null?null:Path.Combine(copy,p.Replace('/','\\'));
            if(dir){manifest.Add(p,DirectoryMark);if(to!=null)Directory.CreateDirectory(to);return;}
            budget.Bytes+=size;if(budget.Bytes>TreeLimit)WorkspacePath.Deny("WORKSPACE_TREE_LIMIT");
            using(var file=new WorkspacePath(root,identity)){
                byte[] bytes=file.Read(p,FileLimit);manifest.Add(p,WorkspacePath.Revision(bytes));
                if(to!=null)File.WriteAllBytes(to,bytes);
            }
        });return manifest;
    }
    public sealed class Baseline {public string treeId;public Dictionary<string,string> files;}
    public static void Stage(string root,string identity,string dir){
        string tree=Path.Combine(dir,"work");Directory.CreateDirectory(tree);
        var files=Scan(root,identity,tree);
        using(var staged=new WorkspacePath(tree,null)){
            var baseline=new Baseline{treeId=staged.Stat.Identity,files=files};
            File.WriteAllText(Path.Combine(dir,"baseline.json"),WorkspaceSnapshot.Json.Serialize(baseline));
        }
    }
    static string Value(Dictionary<string,string> map,string path){string v;return map.TryGetValue(path,out v)?v:null;}
    static string CurrentVersion(string root,string id,string path) {
        try{
            using(var file=new WorkspacePath(root,id))using(var h=file.Leaf(path,null,0x80,3)){if(file.Stat.IsDirectory)return DirectoryMark;}
            using(var file=new WorkspacePath(root,id))return WorkspacePath.Revision(file.Read(path,FileLimit));
        }catch(Win32Exception e){if(WorkspacePath.Missing(e))return null;throw;}
    }
    public static void Apply(string root,string id,string dir){
        var baseline=WorkspaceSnapshot.Json.Deserialize<Baseline>(File.ReadAllText(Path.Combine(dir,"baseline.json")));
        var before=new Dictionary<string,string>(baseline.files,Names);string tree=Path.Combine(dir,"work");
        var after=Scan(tree,baseline.treeId,null);
        var changes=before.Keys.Union(after.Keys,Names).Where(p=>Value(before,p)!=Value(after,p)).ToArray();
        var replacingFiles=new HashSet<string>(changes.Where(p=>Value(before,p)!=null&&Value(before,p)!=DirectoryMark&&Value(after,p)==DirectoryMark),Names);
        foreach(var p in changes){
            // A new descendant was unreachable in the original tree when its parent was a file.
            string parent=p;bool newDescendant=false;int slash;
            while((slash=parent.LastIndexOf('/'))>=0){parent=parent.Substring(0,slash);if(replacingFiles.Contains(parent)){newDescendant=true;break;}}
            if(!newDescendant&&CurrentVersion(root,id,p)!=Value(before,p))WorkspacePath.Deny("FILE_VERSION_CONFLICT");
        }
        string cancel=Path.Combine(dir,"cancel");
        Action check=delegate {if(File.Exists(cancel))WorkspacePath.Deny("TASK_CANCELLED");};
        check();
        if(changes.Length==0){WorkspaceSnapshot.Print(new {changed=0});return;}
        File.WriteAllText(Path.Combine(dir,"applying"),"");
        bool mutated=false;
        try {
            foreach(var p in changes.OrderByDescending(k=>k.Length)){
                string a=Value(before,p),b=Value(after,p);
                if(a==null||(b!=null&&((a==DirectoryMark)==(b==DirectoryMark))))continue;
                check();
                using(var live=new WorkspacePath(root,id))live.Remove(p,a,FileLimit);
                mutated=true;
            }
            foreach(var p in changes.OrderBy(k=>k.Length)){
                string b=Value(after,p);if(b==null)continue;
                check();
                using(var live=new WorkspacePath(root,id)){
                    if(b==DirectoryMark){var parts=WorkspacePath.Parts(p);live.Enter(parts,parts.Length,true);}
                    else using(var staged=new WorkspacePath(tree,baseline.treeId)){
                        string a=Value(before,p);live.Write(p,a==null||a==DirectoryMark?"absent":a,staged.Read(p,FileLimit),FileLimit);
                    }
                }
                mutated=true;
            }
        } catch {if(mutated)WorkspacePath.Deny("WORKSPACE_COMMIT_UNCERTAIN");throw;}
        WorkspaceSnapshot.Print(new {changed=changes.Length});
    }
}
