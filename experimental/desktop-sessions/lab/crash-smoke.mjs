import {readFile,writeFile} from 'node:fs/promises';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function crashSmoke({request,ready,backendPid}){
 async function until(fn){const end=Date.now()+40000;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(150);}throw Error('CRASH_SETUP_TIMEOUT');}
 await until(ready);const [a]=JSON.parse(await readFile('/etc/anywhere-desktop2/catalog.json','utf8'));
 await request('registerWorkspace',{path:a.path});await request('connect',{});await request('permission',{workspaceId:a.id,mode:'execute'});
 await until(async()=>{const s=await request('state',{}),p=s.projects.find(p=>p.id===a.id);return s.connection==='connected'&&p.permission.synced&&!p.blockers;});
 const s=await request('createSession',{workspaceId:a.id,title:'异常退出验证 '+Date.now()});
 const receipt=await request('send',{sessionId:s.id,text:'/long'});
 const turn=await until(async()=>{const t=(await request('state',{})).sessions.find(v=>v.id===s.id).activeTurn;return t?.state==='running'&&t;});await sleep(1200);
 await writeFile('/srv/anywhere-lab/artifacts/desktop-d2-crash-start.json',JSON.stringify({at:new Date().toISOString(),sessionId:s.id,turnId:receipt.turnId,operationId:turn.operationId,workspaceId:a.id,backendPid,testOnly:true},null,2));
 // Only this test's own VM controller child; systemd must clean up D2 units.
 process.kill(backendPid,'SIGKILL');
}
