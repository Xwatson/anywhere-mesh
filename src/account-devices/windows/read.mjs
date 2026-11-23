import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { TextFileHandler } from './vendor/text.mjs';
import { fail, hash } from '../../execution/protocol.mjs';
import { relative } from '../../desktop-commander/adapter.mjs';
import { applyHunks, parsePatch } from '../../workspace/patch.mjs';
import { runTask } from './tasks.mjs';

const exec = promisify(execFile);
const snapshotLimit = 1024*1024;
const imageInlineLimit = 128*1024;
const imageMimes = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
const options = {windowsHide:true,timeout:10000,maxBuffer:snapshotLimit+4096};
const textReader = new TextFileHandler();
const revision = bytes => 'file-v1:'+createHash('sha256').update(bytes).digest('hex');
const response = text => ({version:1,ok:true,calls:1,response:{content:[{type:'text',text}]}});
const tools = ['workspace_read_file','workspace_read_files','workspace_file_info','workspace_list_directory',
  'workspace_search','workspace_create_directory','workspace_write_file','workspace_edit_file',
  'workspace_delete_file','workspace_move_file','workspace_apply_patch','workspace_run'];
const reading = new Set(['read_file','read_multiple_files','get_file_info','list_directory']);
const writing = new Set(['write_file','edit_block','create_directory','delete_file','move_file','apply_patch']);

function decode(bytes) {
  try {new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {fail('TEXT_FILE_REQUIRED');}
  if (bytes.includes(0)) fail('TEXT_FILE_REQUIRED');
  return bytes.toString('utf8');
}
function nativeError(error, mutating) {
  const message=error.stderr?.toString().trim();
  if (/^[A-Z_]{1,60}$/.test(message)) fail(message);
  if (mutating && error.code!=='ENOENT') fail('WORKSPACE_COMMIT_UNCERTAIN');
  if (error.name==='AbortError') throw error;
  fail('WORKSPACE_OPERATION_FAILED');
}
async function backup(stateDir,operationId,path,bytes) {
  const dir=join(stateDir,'file-backups');
  await mkdir(dir,{recursive:true});
  const data=JSON.stringify({path,revision:bytes?revision(bytes):null,data:bytes?.toString('base64')??''});
  const target=join(dir,hash(operationId)+'.json');
  const files=await readdir(dir);
  let used=Buffer.byteLength(data);
  for (const file of files) used+=(await stat(join(dir,file))).size;
  if (used>64*1024*1024) fail('BACKUP_STORAGE_FULL');
  try {await writeFile(target,data,{flag:'wx',mode:0o600,flush:true});}
  catch(error){if(error.code!=='EEXIST'||await readFile(target,'utf8')!==data)throw error;}
}

export function windowsWorkspace(executable) {
  return {
    modes:['revoked','read','edit','execute'],
    sandbox:{network:false,guardedFileWrites:true,fileWriteProtection:'optimistic-version-check-with-preimage',
      supportedTools:tools,isolation:'windows-appcontainer',shell:'cmd.exe'},
    identifyRoot(root) {
      const identity=execFileSync(executable,[root],{...options,encoding:'utf8'}).trim();
      if(!/^[A-F0-9]{8}:[A-F0-9]{16}$/.test(identity)) fail('WORKSPACE_ROOT_CHANGED');
      return identity;
    },
    launcher({workspaceRoot,rootIdentity,stateDir}) {
      const scratch=join(stateDir,'windows-read-snapshots');
      mkdirSync(scratch,{recursive:true});
      async function guard(args,{signal,bytes,mutating=false,timeout=10000}={}) {
        try {
          if (bytes===undefined) return (await exec(executable,[workspaceRoot,rootIdentity,...args],
            {...options,timeout,signal,encoding:'buffer'})).stdout;
          return await new Promise((resolve,reject)=>{
            const child=execFile(executable,[workspaceRoot,rootIdentity,...args],{...options,timeout,encoding:'buffer'},
              (error,out,err)=>{if(error){error.stderr=err;reject(error);}else resolve(out);});
            child.stdin.on('error',()=>{});child.stdin.end(bytes);
          });
        } catch(error){nativeError(error,mutating);}
      }
      async function page(path,offset,length,signal) {
        const bytes=await guard([path],{signal});decode(bytes);signal.throwIfAborted();
        const stage=await mkdtemp(join(scratch,'read-'));
        try {
          const file=join(stage,'text.txt');await writeFile(file,bytes,{flag:'wx',signal});
          const {content}=await textReader.read(file,{offset,length,signal});
          return {content,version:{path,revision:revision(bytes),size:bytes.length}};
        } finally {await rm(stage,{recursive:true,force:true,maxRetries:3});}
      }
      async function readTool(r,signal) {
        const a=r.args,p=a.arguments;
        if (r.kind==='dc.search'||a.tool==='list_directory') {
          const args=r.kind==='dc.search'?['search',a.path,a.searchType,a.pattern,String(a.literalSearch),String(a.maxResults)]:
            ['list',p.path,String(p.depth??2)];
          const {entries,truncated}=JSON.parse(await guard(args,{signal}));
          return response(entries.join('\n')+(truncated?'\n[results truncated]':''));
        }
        if (a.tool==='get_file_info') return response((await guard(['info',p.path],{signal})).toString('utf8').trim());
        const paths=p.paths??[p.path], content=[], versions=[];
        if (!p.paths) {
          const mime=imageMimes[extname(p.path).toLowerCase()];
          if (mime) {
            const bytes=await guard(['read-image',p.path],{signal,timeout:10000});
            const ver={path:p.path,revision:revision(bytes),size:bytes.length};
            if (bytes.length<=imageInlineLimit) {
              return {version:1,ok:true,calls:1,response:{content:[
                {type:'image',data:bytes.toString('base64'),mimeType:mime},
                {type:'text',text:`Image ${p.path} (${mime}, ${bytes.length} bytes)\nFile versions (expectedRevision): ${JSON.stringify([ver])}`}
              ]},fileVersions:[ver]};
            }
            return response(`Image ${p.path} (${mime}, ${bytes.length} bytes) exceeds inline preview limit (${imageInlineLimit} bytes).`);
          }
        }
        for(const path of paths) {
          try{
            const item=await page(path,p.offset??0,p.length??100,signal);
            content.push({type:'text',text:(paths.length>1?path+'\n':'')+item.content});versions.push(item.version);
          } catch(error){if(!p.paths||signal.aborted)throw error;content.push({type:'text',text:path+': '+error.code});}
        }
        content.push({type:'text',text:'File versions (expectedRevision): '+JSON.stringify(versions)});
        return {version:1,ok:true,calls:1,response:{content},fileVersions:versions};
      }
      async function readOptional(path,signal) {
        try {return await guard([path],{signal});}
        catch(error){if(error.code==='FILE_NOT_FOUND')return undefined;throw error;}
      }
      async function writeTool(op,signal) {
        const {tool,arguments:p}=op.request.args;
        if(tool==='create_directory'){
          signal.throwIfAborted();await guard(['mkdir',p.path],{mutating:true});
          return {...response('Directory ready: '+p.path),committed:true};
        }
        if(tool==='delete_file'){
          const original=await readOptional(p.path,signal);
          if(!original)fail('FILE_NOT_FOUND');
          if(revision(original)!==p.expectedRevision)fail('FILE_VERSION_CONFLICT');
          await backup(stateDir,op.operationId,p.path,original);
          signal.throwIfAborted();
          await guard(['remove',p.path,p.expectedRevision],{mutating:true});
          return {...response('Deleted '+p.path),committed:true};
        }
        if(tool==='move_file'){
          const fromBytes=await readOptional(p.fromPath,signal);
          if(!fromBytes)fail('FILE_NOT_FOUND');
          if(revision(fromBytes)!==p.expectedFromRevision)fail('FILE_VERSION_CONFLICT');
          decode(fromBytes);
          const toBytes=await readOptional(p.toPath,signal);
          if((toBytes?revision(toBytes):null)!==p.expectedToRevision)fail('FILE_VERSION_CONFLICT');
          await backup(stateDir,op.operationId+':from',p.fromPath,fromBytes);
          await backup(stateDir,op.operationId+':to',p.toPath,toBytes);
          signal.throwIfAborted();
          const parent=dirname(p.toPath);
          if(parent && parent!=='.') await guard(['mkdir',parent],{mutating:true});
          await guard(['write',p.toPath,p.expectedToRevision??'absent'],{bytes:fromBytes,mutating:true});
          await guard(['remove',p.fromPath,p.expectedFromRevision],{mutating:true});
          const version={path:p.toPath,revision:revision(fromBytes),size:fromBytes.length};
          return {...response('Moved '+p.fromPath+' -> '+p.toPath+'\nFile version: '+version.revision),fileVersions:[version],committed:true};
        }
        if(tool==='apply_patch'){
          const ops=parsePatch(p.patch);
          const revMap=p.expectedRevisions;
          const stagedWrites=[], stagedRemoves=[], backups=[], summary=[], touched=new Set();
          for(const item of ops){
            relative(item.path);
            if(item.moveTo) relative(item.moveTo);
            if(touched.has(item.path) || (item.moveTo && touched.has(item.moveTo))) fail('PATCH_DUPLICATE_PATH');
            touched.add(item.path); if(item.moveTo) touched.add(item.moveTo);
            if(!Object.hasOwn(revMap,item.path)) fail('FILE_REVISION_REQUIRED');
            const orig=await readOptional(item.path,signal);
            if((orig?revision(orig):null)!==revMap[item.path]) fail('FILE_VERSION_CONFLICT');
            if(item.kind==='add'){
              if(orig) fail('FILE_VERSION_CONFLICT');
              const text=item.lines.length?item.lines.join('\n')+'\n':'';
              const bytes=Buffer.from(text);
              if(bytes.includes(0)||bytes.length>snapshotLimit) fail('INVALID_TEXT');
              backups.push([item.path,undefined]);
              stagedWrites.push({path:item.path,expected:'absent',bytes});
              summary.push('Add '+item.path);
            } else if(item.kind==='delete'){
              if(!orig) fail('FILE_NOT_FOUND');
              backups.push([item.path,orig]);
              stagedRemoves.push({path:item.path,expected:revMap[item.path]});
              summary.push('Delete '+item.path);
            } else {
              if(!orig) fail('FILE_NOT_FOUND');
              const before=decode(orig);
              const after=item.hunks.length?applyHunks(before,item.hunks,item.path):before;
              const bytes=Buffer.from(after);
              if(bytes.includes(0)||bytes.length>snapshotLimit) fail('INVALID_TEXT');
              const dest=item.moveTo??item.path;
              if(dest!==item.path){
                if(!Object.hasOwn(revMap,dest)) fail('FILE_REVISION_REQUIRED');
                const destOrig=await readOptional(dest,signal);
                if((destOrig?revision(destOrig):null)!==revMap[dest]) fail('FILE_VERSION_CONFLICT');
                backups.push([item.path,orig],[dest,destOrig]);
                stagedWrites.push({path:dest,expected:revMap[dest]??'absent',bytes});
                stagedRemoves.push({path:item.path,expected:revMap[item.path]});
                summary.push('Move '+item.path+' -> '+dest);
              } else {
                backups.push([item.path,orig]);
                stagedWrites.push({path:item.path,expected:revMap[item.path],bytes});
                summary.push('Update '+item.path);
              }
            }
          }
          for(let idx=0;idx<backups.length;idx++) await backup(stateDir,op.operationId+':'+idx,backups[idx][0],backups[idx][1]);
          signal.throwIfAborted();
          const versions=[];
          for(const w of stagedWrites){
            const parent=dirname(w.path);
            if(parent && parent!=='.') await guard(['mkdir',parent],{mutating:true});
            await guard(['write',w.path,w.expected],{bytes:w.bytes,mutating:true});
            versions.push({path:w.path,revision:revision(w.bytes),size:w.bytes.length});
          }
          for(const r of stagedRemoves) await guard(['remove',r.path,r.expected],{mutating:true});
          return {...response('Applied patch: '+summary.join(', ')+'\nFile versions: '+JSON.stringify(versions)),fileVersions:versions,committed:true};
        }
        const path=p.path??p.file_path;
        if(!Object.hasOwn(p,'expectedRevision'))fail('FILE_REVISION_REQUIRED');
        const original=await readOptional(path,signal);
        if((original?revision(original):null)!==p.expectedRevision)fail('FILE_VERSION_CONFLICT');
        const previous=original?decode(original):'';
        let next;
        if(tool==='edit_block'){
          if(!original)fail('FILE_NOT_FOUND');
          const parts=previous.split(p.old_string);
          if(parts.length-1!==p.expected_replacements)fail('EDIT_MATCH_COUNT');
          next=parts.join(p.new_string);
        } else next=(p.mode==='append'?previous:'')+p.content;
        const bytes=Buffer.from(next);
        if(bytes.includes(0)||bytes.length>snapshotLimit)fail('INVALID_TEXT');
        await backup(stateDir,op.operationId,path,original);
        signal.throwIfAborted();
        const parent=dirname(path);
        if(parent && parent!=='.') await guard(['mkdir',parent],{mutating:true});
        await guard(['write',path,p.expectedRevision??'absent'],{bytes,mutating:true});
        const version={path,revision:revision(bytes),size:bytes.length};
        return {...response('Saved '+path+'\nFile version: '+version.revision),fileVersions:[version],committed:true};
      }
      return (op,grant)=>{
        const r=op.request,name=r.args.tool;
        if(!['read','edit','execute'].includes(grant.mode))fail('TOOL_UNAVAILABLE_ON_DEVICE');
        if(r.kind==='dc.run'&&grant.mode==='execute')
          return {mutates:true,perform:(signal,output)=>runTask({stateDir,guard,supervisor:join(dirname(executable),'TaskHost.exe'),request:r,signal,output})};
        if(r.cwdRelative!=='.')fail('TOOL_UNAVAILABLE_ON_DEVICE');
        if(r.kind==='dc.search'||(r.kind==='dc.tool'&&reading.has(name)))return {read:signal=>readTool(r,signal)};
        if(r.kind==='dc.tool'&&writing.has(name)&&grant.mode!=='read')return {mutates:true,perform:signal=>writeTool(op,signal)};
        fail('TOOL_UNAVAILABLE_ON_DEVICE');
      };
    }
  };
}
export {windowsWorkspace as windowsReader};
