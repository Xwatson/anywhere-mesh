import { execFile, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fail } from '../../execution/protocol.mjs';

async function command(supervisor,dir,request,signal,output) {
  signal.throwIfAborted();
  const child=spawn(supervisor,[dir,request.cwdRelative,dirname(process.execPath),String(process.pid)],{
    windowsHide:true,stdio:['pipe','pipe','pipe']
  });
  const end=new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('close',resolve);
  });
  const stop=()=>child.kill();
  signal.addEventListener('abort',stop,{once:true});
  let remaining=64*1024,truncated=false;
  for(const [kind,stream] of [['stdout',child.stdout],['stderr',child.stderr]]){
    const decoder=new StringDecoder('utf8');
    stream.on('data',chunk=>{
      const count=Math.min(remaining,chunk.length);
      for(let i=0;i<count;i+=2048) output(kind,decoder.write(chunk.subarray(i,Math.min(count,i+2048))));
      remaining-=count;
      if(count<chunk.length&&!truncated){truncated=true;output(kind,'\n[output truncated]\n');}
    });
    stream.on('end',()=>{const tail=decoder.end();if(tail)output(kind,tail);});
  }
  child.stdin.on('error',()=>{});child.stdin.end(request.args.input??'');
  try {
    await end;signal.throwIfAborted();
    // The limited process cannot write this receipt. Only TaskHost writes it, after its Job is empty.
    const code=Number((await readFile(join(dir,'exit-code'),'ascii')).trim());
    if(!Number.isInteger(code))fail('WINDOWS_SANDBOX_FAILED');
    return code;
  } catch(error){if(signal.aborted)throw error;fail('WINDOWS_SANDBOX_FAILED');}
  finally{signal.removeEventListener('abort',stop);}
}
export async function runTask({stateDir,guard,supervisor,request,signal,output}) {
  const dir=join(stateDir,'tasks',randomUUID());
  await mkdir(dir,{recursive:true});
  let retain=false;
  try {
    await guard(['stage',dir],{signal,timeout:60000});
    const script='@echo off\r\nchcp 65001 >nul\r\n'+request.args.command.replace(/\r?\n/g,'\r\n')+'\r\n';
    await writeFile(join(dir,'task.cmd'),script,{flag:'wx',signal});
    const code=await command(supervisor,dir,request,signal,output);
    signal.throwIfAborted();
    let changed;
    const cancelApply=()=>{try{writeFileSync(join(dir,'cancel'),'');}catch{}};
    signal.addEventListener('abort',cancelApply,{once:true});
    try {({changed}=JSON.parse(await guard(['apply',dir],{mutating:true,timeout:60000})));}
    catch(error){retain=error.code==='WORKSPACE_COMMIT_UNCERTAIN';throw error;}
    finally{signal.removeEventListener('abort',cancelApply);}
    return {version:1,ok:code===0,calls:1,committed:changed>0,process:{exitCode:code,changed},
      response:{isError:code!==0,content:[{type:'text',text:'Exit code '+code+'; project paths changed: '+changed+'.'}]}};
  } finally {
    // A killed supervisor also kills its job. Remove an abandoned AppContainer profile if needed.
    await new Promise(resolve=>execFile(supervisor,[dir],{windowsHide:true,timeout:5000},resolve));
    if(!retain)await rm(dir,{recursive:true,force:true,maxRetries:3}).catch(()=>{});
  }
}
