import assert from 'node:assert/strict';
import {readFile,writeFile,symlink,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SessionController,BASE} from '../controller.mjs';
import {control} from '../../execution/control.mjs';
const exec=promisify(execFile),run=async(...a)=>(await exec(a[0],a.slice(1),{timeout:40000,maxBuffer:1024*1024})).stdout.trim(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const catalog=JSON.parse(await readFile('/etc/anywhere-desktop2/catalog.json','utf8')),[a,b]=catalog;
let c,failure,relayStopped=false;const results=[],record=(name,extra={})=>{const r={name,passed:true,...extra};results.push(r);console.log(JSON.stringify(r));};
async function until(fn,ms=40000){const end=Date.now()+ms;let error;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch(e){error=e;}await sleep(150);}throw Error('WAIT_TIMEOUT '+(error?.message??''));}
const state=()=>c.request('state'),ready=id=>until(async()=>{const s=await state(),p=s.projects.find(p=>p.id===id);return s.connection==='connected'&&p?.permission.synced&&!p.blockers;});
const mode=async(id,value)=>{await c.request('permission',{workspaceId:id,mode:value});await ready(id);};
const history=id=>c.request('history',{sessionId:id,beforeSeq:0});
const expectedTurns=new Map();
const send=async(sessionId,text)=>{const r=await c.request('send',{sessionId,text});expectedTurns.set(sessionId,r.turnId);return r;};
async function done(id,expected='succeeded'){
 const p=await until(async()=>{
  const s=(await state()).sessions.find(s=>s.id===id),p=await history(id);
  return s&&!s.activeTurn&&p.events.at(-1)?.seq===s.lastSeq&&p.events.at(-1)?.event.type==='turn_end'&&p.events.some(e=>e.event.type==='tool_call'&&e.event.id===expectedTurns.get(id))&&p;
 });
 if(expected==='succeeded')assert.equal(p.events.at(-1).event.ok,true,JSON.stringify(p.events.at(-1)));
 return p;
}
try{
 c=new SessionController();await c.init();assert.equal((await state()).connection,'disconnected');
 await c.request('registerWorkspace',{path:a.path});await c.request('registerWorkspace',{path:b.path});
 await assert.rejects(c.request('registerWorkspace',{path:'/srv/anywhere-lab/source'}),/WORKSPACE_NOT_PROVISIONED/);
 const link=BASE+'/cache/native-picker-link';await symlink(a.path,link).catch(()=>{});await assert.rejects(c.request('registerWorkspace',{path:link}),/WORKSPACE_NOT_PROVISIONED/);await unlink(link);
 record('native_selection_accepts_only_provisioned_real_roots_and_rejects_symlink_or_other_directory');
 await c.request('permission',{workspaceId:a.id,mode:'read'});assert.equal((await state()).projects.find(p=>p.id===b.id).permission.mode,'revoked');
 await c.request('connect');await ready(a.id);await ready(b.id);
 const sa=await c.request('createSession',{workspaceId:a.id,title:'A 联调 '+Date.now()}),sb=await c.request('createSession',{workspaceId:b.id,title:'B 联调 '+Date.now()});
 await send(sa.id,'/read notes.txt');let p=await done(sa.id);assert.match(JSON.stringify(p),/PROJECT_ALPHA/);assert.doesNotMatch(JSON.stringify(p),/PROJECT_BETA/);
 record('https_mtls_session_and_real_mcp_read_arrive_over_easytier_wss_with_bound_project');
 await mode(a.id,'execute');const long=await send(sa.id,'/long');
 await until(async()=>(await state()).sessions.find(s=>s.id===sa.id)?.activeTurn?.state==='running');
 await c.request('selectWorkspace',{workspaceId:b.id});
 await assert.rejects(c.request('send',{sessionId:sb.id,text:'/read notes.txt'}),/LOCAL_PERMISSION_REQUIRED/);
 await mode(b.id,'read');await send(sb.id,'/read notes.txt');p=await done(sb.id);assert.match(JSON.stringify(p),/PROJECT_BETA/);assert.doesNotMatch(JSON.stringify(p),/PROJECT_ALPHA/);
 await c.request('stop',{sessionId:sa.id,turnId:long.turnId});await done(sa.id,'cancelled');
 record('switching_projects_keeps_running_turn_on_A_and_B_permissions_history_and_files_separate');
 await mode(a.id,'edit');
 const peer=JSON.parse(await run('sudo','-n','nsenter','--net=/run/anywhere-network/cn.netns','runuser','-u','lab','--','/usr/local/bin/node','/srv/anywhere-lab/source/experimental/desktop-sessions/lab/peer-check.mjs',sa.id));
 expectedTurns.set(sa.id,peer.turnId);await done(sa.id);const file=await run('sudo','-n','-u','anywhere-exec-agent','cat',a.path+'/notes.txt');assert.equal(file.split(peer.marker).length-1,1);
  await run('sudo','-n','nsenter','--net=/run/anywhere-network/cn.netns','/usr/local/bin/node','/srv/anywhere-lab/source/experimental/desktop-sessions/lab/role-check.mjs');
 record('http_duplicate_send_is_one_effect_and_client_pin_scope_permission_routes_and_request_conflicts_are_enforced');
 await mode(a.id,'execute');
 const countStarts=async()=>(await run('sudo','-n','-u','anywhere-exec-agent','cat',a.path+'/long.starts')).split('\n').filter(Boolean).length;
 const priorStarts=await countStarts();await send(sa.id,'/long');
 await until(async()=>(await state()).sessions.find(s=>s.id===sa.id)?.activeTurn?.state==='running'&&(await countStarts())===priorStarts+1);
 const before=await run('sudo','-n','-u','anywhere-exec-agent','cat',a.path+'/long.starts');
 await run('sudo','-n','systemctl','restart','anywhere-desktop2-host.service');await ready(a.id);p=await done(sa.id);assert.equal(await run('sudo','-n','-u','anywhere-exec-agent','cat',a.path+'/long.starts'),before);
 assert.equal(new Set(p.events.map(e=>e.seq)).size,p.events.length);
 record('host_restart_recovers_running_task_once_and_wss_history_resumes_by_persisted_cursor');
 const offline=await send(sa.id,'/long');await until(async()=>(await state()).sessions.find(s=>s.id===sa.id)?.activeTurn?.state==='running');
 await run('docker','stop','-t','2','anywhere-helper-relay-1');relayStopped=true;
  await until(async()=>(await state()).connection!=='connected',20000);
 await c.request('permission',{workspaceId:a.id,mode:'revoked'});assert.equal((await state()).projects.find(p=>p.id===a.id).permission.mode,'revoked');
 assert.ok((await history(sa.id)).events.length);await run('docker','start','anywhere-helper-relay-1');relayStopped=false;
 await ready(a.id);await done(sa.id,'cancelled');
 record('relay_loss_keeps_cached_history_and_local_revoke_usable_then_reconciles_without_resend');
 await mode(a.id,'edit');await send(sa.id,'/read notes.txt');await done(sa.id);
 await run('sudo','-n','-u','anywhere-exec-agent','python3','-c',`from pathlib import Path;Path('${BASE}/agents/a/fault.json').write_text('{"point":"agent_before_result"}')`);
 const unknown=await send(sa.id,'/append notes.txt D2_UNKNOWN_CHECK');
 await until(async()=>await run('systemctl','show','--value','-p','ActiveState','anywhere-desktop2-agent-a.service')==='failed');
 await run('sudo','-n','systemctl','start','anywhere-desktop2-agent-a.service');
 await until(async()=>(await state()).sessions.find(s=>s.id===sa.id)?.activeTurn?.state==='unknown');
 const unknownPage=await history(sa.id);assert.notEqual(unknownPage.events.at(-1).event.type,'turn_end');
 await c.request('permission',{workspaceId:a.id,mode:'revoked'});
 await assert.rejects(c.request('reviewPreview',{sessionId:sb.id,turnId:unknown.turnId}),/TURN_NOT_BOUND/);
 const preview=await c.request('reviewPreview',{sessionId:sa.id,turnId:unknown.turnId});
 await c.request('review',{sessionId:sa.id,turnId:unknown.turnId,digest:preview.digest,note:'Lab check: notes.txt has the appended marker; preserve unknown outcome and close without replay.'});await done(sa.id,'reviewed');
 record('unknown_has_no_premature_turn_end_and_local_review_cannot_cross_session_workspace_binding');
 const ids=(await state()).sessions.map(s=>s.id).sort();await c.shutdown();c=new SessionController();await c.init();
 const restored=await state();assert.equal(restored.connection,'disconnected');assert.ok(restored.projects.every(p=>p.permission.mode==='revoked'));assert.deepEqual(restored.sessions.map(s=>s.id).sort(),ids);assert.ok((await history(sa.id)).events.length);
 record('desktop_cold_restart_opens_cached_sessions_offline_with_all_project_permissions_revoked');
}catch(e){failure=e;console.error(e.stack);}
finally{if(relayStopped)await run('docker','start','anywhere-helper-relay-1').catch(()=>{});await c?.shutdown().catch(e=>{failure??=e;});await writeFile('/srv/anywhere-lab/artifacts/desktop-d2-integration.json',JSON.stringify({passed:!failure,realCli:false,results,error:failure?.stack??null},null,2));}
if(failure)process.exitCode=1;
