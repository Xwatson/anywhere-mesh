import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WindowsClient } from './client.mjs';
import { WindowsPeer } from './network.mjs';
import { windowsWorkspace } from './read.mjs';

if (process.platform !== 'win32') throw Error('WINDOWS_REQUIRED');
const root = join(process.env.LOCALAPPDATA,'AnywhereMesh');
const cfg = {stateDir:join(root,'state'), name:'Windows · '+hostname(), url:'https://127.0.0.1:31844',
  ca:join(root,'ca.crt'), projects:[{label:'Windows 本地项目', path:join(root,'project')}]};
const input = createInterface({input:process.stdin});
const peer = new WindowsPeer(root,readFileSync(cfg.ca));
const protector=fileURLToPath(new URL('./LoginProtection.exe',import.meta.url));
function protect(mode, input) {
  const result=spawnSync(protector,[mode],{input,windowsHide:true,timeout:6000,maxBuffer:16384});
  if(result.status!==0 || !result.stdout?.length) throw Error('LOGIN_STORAGE_UNAVAILABLE');
  return result.stdout;
}
const reply = value => process.stdout.write(JSON.stringify(value)+'\n');
const workspace=windowsWorkspace(fileURLToPath(new URL('./WorkspaceSnapshot.exe',import.meta.url)));
const client=new WindowsClient(cfg,{...workspace,
  onStream:data=>reply({event:'stream',data}),
  loginProtection:{
    seal:bytes=>protect('seal',bytes),open:bytes=>protect('open',bytes)
  }},{peer,privatePaths:[root,resolve(import.meta.dirname,'../../..'),dirname(process.execPath)]});
if (peer.legacy) await peer.start().catch(()=>{});
// Recover a missing peer even when the window is minimized.
const repair = setInterval(() => {
  const signed = client.signed;
  if (!signed || client.repairPending) return;
  client.repairPending=client.enqueue(()=>client.recover(signed)).catch(()=>{}).finally(()=>{client.repairPending=null;});
},30000);
reply({event:'ready'});
try {
  const inflight = new Set();
  for await (const line of input) {
    const task = (async () => {
      let id;
      try {
        if (line.length>16*1024*1024) throw Error('INVALID_FRAME');
        const frame = JSON.parse(line); id = frame.id;
        reply({id,value:await client.control(frame.method,frame.params)});
      } catch (error) { reply({id,error:error.code ?? error.message}); }
    })();
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  }
  await Promise.allSettled([...inflight]);
} finally {
  clearInterval(repair);
  try { await client.suspend(); } finally { await peer.stop(); }
}
