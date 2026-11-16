import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {SessionController,BASE} from '../controller.mjs';
import {NetworkClient} from '../../../native/linux/network-helper/client.mjs';
const exec=promisify(execFile),run=async(...a)=>(await exec(a[0],a.slice(1),{timeout:20000})).stdout.trim(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+45000;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(180);}throw Error('CRASH_CHECK_TIMEOUT');}
const results=[],record=name=>{results.push({name,passed:true});console.log(name);};let c,failure;
try{
 await run('bash','/srv/anywhere-lab/scripts/guest-guard.sh');
 await run('sudo','-n','systemctl','start','anywhere-desktop2-crash-test.service');
 await until(async()=>(await run('systemctl','show','--value','-p','ActiveState','anywhere-desktop2-crash-test.service'))==='inactive');
 const start=JSON.parse(await readFile('/srv/anywhere-lab/artifacts/desktop-d2-crash-start.json','utf8'));
 assert.ok(Date.now()-Date.parse(start.at)<15000,'cleanup cannot wait for the natural task deadline');
 for(const role of ['agent-a','agent-b','host','bridge'])assert.equal(await run('systemctl','show','--value','-p','ActiveState',`anywhere-desktop2-${role}.service`),'inactive');
 for(const role of ['cn','us']){const h=await NetworkClient.connect(`/run/anywhere-network/${role}.sock`);try{await until(async()=>(await h.status()).phase==='idle');}finally{await h.close();}}
 record('controller_sigkill_exits_D2_window_stops_all_four_scoped_services_and_releases_both_leases');
 const [a]=JSON.parse(await readFile('/etc/anywhere-desktop2/catalog.json','utf8'));
 const before=await run('sudo','-n','-u','anywhere-exec-agent','cat',a.path+'/long.starts');
 c=new SessionController();await c.init();assert.ok((await c.request('state')).projects.every(p=>p.permission.mode==='revoked'));await c.request('connect');
 await until(async()=>(await c.request('state')).connection==='connected');
 const session=await until(async()=>{const s=(await c.request('state')).sessions.find(s=>s.id===start.sessionId);return s&&(!s.activeTurn||s.activeTurn.state==='unknown')&&s;});
 if(session.activeTurn){const p=await c.request('reviewPreview',{sessionId:start.sessionId,turnId:start.turnId});await c.request('review',{sessionId:start.sessionId,turnId:start.turnId,digest:p.digest,note:'Lab controller-crash check: scoped cgroups stopped; long.starts has one start. Preserve unknown outcome and close without replay.'});}
 await until(async()=>!(await c.request('state')).sessions.find(s=>s.id===start.sessionId).activeTurn);
 const starts=await run('sudo','-n','python3','-c',`import sqlite3,json;d=sqlite3.connect('${BASE}/agents/a/journal.sqlite');r=d.execute("select value from records where bucket='ops' and key=?",('${start.operationId}',)).fetchone() or d.execute("select value from archive_records where bucket='ops' and key=?",('${start.operationId}',)).fetchone();print(json.loads(r[0])['starts'])`);
 assert.equal(starts,'1');assert.equal(await run('sudo','-n','-u','anywhere-exec-agent','cat',a.path+'/long.starts'),before);
 record('D2_cold_restart_revokes_both_projects_and_retains_one_start_through_unknown_review_without_replay');
}catch(e){failure=e;console.error(e.stack);}
finally{await c?.shutdown().catch(e=>{failure??=e;});await writeFile('/srv/anywhere-lab/artifacts/desktop-d2-crash-check.json',JSON.stringify({passed:!failure,realCli:false,results,error:failure?.stack??null},null,2));}
if(failure)process.exitCode=1;
