import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '../../workspace/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../workspace/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { NetworkClient } from '../../../native/linux/network-helper/client.mjs';
import { Journal } from '../../execution/journal.mjs';
import { control } from '../../execution/control.mjs';
import { WorkspaceExecutor } from '../../workspace/executor.mjs';

const exec=promisify(execFile),base='/srv/anywhere-lab/reliability-c',runId=new Date().toISOString().replace(/\D/g,'');
const run=async(...a)=>(await exec(a[0],a.slice(1),{timeout:40000,maxBuffer:2*1024*1024})).stdout.trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const broker=(m,p={})=>control(`${base}/broker/control.sock`,m,p),local=(m,p={})=>control(`${base}/local/control.sock`,m,p);
const svc=(action,...roles)=>run('sudo','-n','systemctl',action,...roles.map(r=>`anywhere-reliability-${r}.service`));
const text=r=>r.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')??'';
const holders=[],clients=[],results=[];let facade,history,failure,mockStopped=false;
const record=(name,extra={})=>{const value={name,passed:true,...extra};results.push(value);console.log(JSON.stringify(value));};
async function until(fn,timeout=40000){const end=Date.now()+timeout;let error;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(e){error=e;}await sleep(100);}throw Error('CONDITION_TIMEOUT: '+(error?.message??''));}
const ready=()=>until(async()=>(await broker('workspace')).confirmed);
async function setMode(mode,{wait=true}={}){
  const status=await local('status'),params={requestId:randomUUID(),expectedVersion:status.grant.grantVersion,mode};
  const decision=await local('setMode',params);
  if(wait)await until(async()=>{const r=await broker('workspace');return r.confirmed&&r.grant.grantVersion===decision.grant.grantVersion;});
  return decision;
}
async function openHost(){
  const grant=(await broker('workspace')).grant,binding=Object.fromEntries(['accountId','deviceId','workspaceId','grantVersion'].map(k=>[k,grant[k]]));
  Object.assign(binding,{sessionId:'reliability-mock',turnId:randomUUID(),turnEpoch:1});
  const config=`${base}/facade/host-${randomUUID()}.json`;
  await writeFile(config,JSON.stringify({binding,journalPath:`${base}/facade/tickets.sqlite`,brokerSocket:`${base}/broker/control.sock`}),{mode:0o600});
  const client=new Client({name:'reliability-mock-host',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['/usr/lib/anywhere-reliability-runtime/workspace/mcp.mjs',config],stderr:'pipe',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}});
  const connecting=client.connect(transport);transport.stderr?.resume();await connecting;clients.push(client);
  return{client,executor:new WorkspaceExecutor({journal:facade,control:broker,binding})};
}
const invoke=(h,name,args,ticket)=>h.client.callTool({name,arguments:args,_meta:{'anywhere/callTicket':ticket.ticket}},undefined,{timeout:30000});
async function finish(h,ticket,response){
  let r=response;
  if(!r?.structuredContent?.task?.resultReady)r=await until(async()=>{const value=await h.client.callTool({name:'workspace_task_status',arguments:{operationId:ticket.operationId}});return value.structuredContent?.task?.resultReady&&value;});
  const task=r.structuredContent.task,outputs=[];let cursor=0;
  while(cursor<task.lastSeq){const p=await h.client.callTool({name:'workspace_task_output',arguments:{operationId:task.operationId,afterSeq:cursor}});assert.ok(!p.isError);const page=p.structuredContent;outputs.push(page);assert.ok(page.nextSeq>cursor);cursor=page.nextSeq;}
  const receiptId=`mock-history:${task.operationId}`;
  history.put('results',task.operationId,{digest:task.resultDigest,result:r,outputs,receiptId});
  await h.executor.consumeAfterPersist({operationId:task.operationId,resultDigest:task.resultDigest,receiptId});
  return{result:r,outputs};
}
async function call(h,name,args,{expected='succeeded'}={}){
  const ticket=await h.executor.issue(randomUUID(),name,args),done=await finish(h,ticket,await invoke(h,name,args,ticket));
  assert.equal(done.result.structuredContent.task.state,expected,JSON.stringify(done.result));return done;
}
const readWorkspace=name=>run('sudo','-n','-u','anywhere-exec-agent','cat',`${base}/workspace/${name}`);
const fixture={'source.txt':'Initial\nHello Workspace\n','oversize.txt':'Z'.repeat(100000),
  'long.mjs':"import{appendFileSync}from'node:fs';appendFileSync('long.starts','once\\n');const tick=setInterval(()=>console.log('tick'),100);setTimeout(()=>{clearInterval(tick);console.log('LONG_DONE');},15000);"};
await run('bash','/srv/anywhere-lab/scripts/guest-guard.sh');await svc('stop','agent','broker');
await run('sudo','-n','python3','-c',`import pathlib,shutil,os,pwd,grp,json,sys
b=pathlib.Path('${base}');a=b/'archive'/'${runId}';a.mkdir(parents=True)
for name in ['agent','broker','workspace','local','facade']:
 p=b/name
 if p.exists():shutil.move(str(p),str(a/name))
 p.mkdir();u='lab' if name=='facade' else 'anywhere-exec-broker' if name=='broker' else 'anywhere-exec-agent';g='lab' if name in ['local','facade','broker'] else u
 os.chown(p,pwd.getpwnam(u).pw_uid,grp.getgrnam(g).gr_gid);p.chmod(0o2750 if name=='local' else 0o750 if name=='broker' else 0o700)
for name,text in json.loads(sys.argv[1]).items():
 p=b/'workspace'/name;p.write_text(text);os.chown(p,pwd.getpwnam('anywhere-exec-agent').pw_uid,grp.getgrnam('anywhere-exec-agent').gr_gid);p.chmod(0o600)
`,JSON.stringify(fixture));
facade=new Journal(`${base}/facade/tickets.sqlite`);history=new Journal(`${base}/facade/mock-history.sqlite`);
try{
  for(const side of ['cn','us']){const h=await NetworkClient.connect(`/run/anywhere-network/${side}.sock`);holders.push(h);await h.acquire();}
  for(const h of holders)await h.waitConnected(30000);
  await run('docker','stop','-t','2','anywhere-helper-us-mock-1');mockStopped=true;
  await svc('start','broker','agent');await ready();assert.equal((await local('status')).grant.mode,'revoked');
  await setMode('edit');const first=await openHost();
  let done=await call(first,'workspace_read_file',{path:'source.txt'}),revision=done.result.structuredContent.result.fileVersions[0].revision;
  assert.match(revision,/^file-v1:/);
  done=await call(first,'workspace_edit_file',{path:'source.txt',oldText:'Initial',newText:'AI edit',expectedRevision:revision});
  assert.equal(done.result.structuredContent.result.fileGuard.protection,'optimistic-version-check-with-preimage');
  assert.match(await readWorkspace('source.txt'),/AI edit/);
  revision=done.result.structuredContent.result.fileVersions[0].revision;
  record('real_desktop_commander_edits_private_snapshot_then_commits_guarded_revision');
  await run('sudo','-n','-u','anywhere-exec-agent','python3','-c',`from pathlib import Path;Path('${base}/workspace/source.txt').write_text('LOCAL EDIT\\nHello Workspace\\n')`);
  done=await call(first,'workspace_edit_file',{path:'source.txt',oldText:'AI edit',newText:'OVERWRITE',expectedRevision:revision},{expected:'failed'});
  assert.match(JSON.stringify(done.result),/FILE_VERSION_CONFLICT/);assert.equal(await readWorkspace('source.txt'),'LOCAL EDIT\nHello Workspace');
  record('external_editor_change_is_refused_without_overwriting_local_content');
  const onceArgs={path:'once.txt',content:'once\n',mode:'append',expectedRevision:null},once=await first.executor.issue('stable-append','workspace_write_file',onceArgs);
  const duplicate=await Promise.all([invoke(first,'workspace_write_file',onceArgs,once),invoke(first,'workspace_write_file',onceArgs,once)]);
  await finish(first,once,duplicate[0]);assert.equal(await readWorkspace('once.txt'),'once');
  record('guarded_create_and_concurrent_retry_write_only_once');
  done=await call(first,'workspace_read_file',{path:'oversize.txt',length:1},{expected:'failed'});assert.match(text(done.result),/RESULT_TOO_LARGE/);
  assert.equal((await broker('workspace')).blockers.length,0);record('oversized_read_fails_explicitly_without_creating_unknown_task');
  for(let i=0;i<70;i++)await setMode(i%2?'edit':'read',{wait:false});
  const latest=(await local('status')).grant.grantVersion;await until(async()=>(await broker('workspace')).grant.grantVersion===latest);
  assert.ok(latest>64);assert.ok((await local('status')).history.archivedRecords>0);
  record('seventy_permission_changes_preserve_old_versions_and_keep_local_revocation_available',{grantVersion:latest});
  let host=await openHost();
  for(let i=0;i<140;i++){
    await call(host,'workspace_read_file',{path:'source.txt',length:1});
    if((i+1)%20===0)console.log(JSON.stringify({progress:'real_mcp_retention_calls',completed:i+1,total:140}));
  }
  await until(async()=>(await broker('snapshot')).ops.length<=32);
  assert.ok((await broker('workspace')).history.archivedRecords>100);assert.equal(facade.all('calls').length,32);
  const replay=await first.executor.issue('stable-append','workspace_write_file',onceArgs);assert.deepEqual(replay,once);
  done=await finish(first,once,await invoke(first,'workspace_write_file',onceArgs,once));
  assert.equal((await broker('operation',{operationId:once.operationId})).starts,1);assert.equal(await readWorkspace('once.txt'),'once');
  record('more_than_128_real_calls_compact_all_three_journals_and_old_mutation_stays_deduplicated',{calls:140,broker:(await broker('workspace')).history,facade:facade.storage()});
  await setMode('execute');host=await openHost();
  done=await call(host,'workspace_run',{command:`node -e "process.stdout.write('X'.repeat(200000)+'\\nTAIL_OK\\n')"`});
  const output=done.outputs.flatMap(p=>p.rows).map(r=>r.data).join('');assert.match(output,/TAIL_OK/);
  assert.ok(done.result.structuredContent.task.gaps.length>0||done.result.structuredContent.output.truncatedThrough>0);assert.ok(Buffer.byteLength(output)<=65536);
  record('large_command_output_has_bounded_storage_explicit_gap_and_final_tail');
  const longArgs={command:'node long.mjs'},long=await host.executor.issue('long-command','workspace_run',longArgs);
  const waiting=invoke(host,'workspace_run',longArgs,long).catch(()=>null);await until(async()=>await readWorkspace('long.starts')==='once');
  await svc('restart','broker');await ready();await waiting;
  done=await finish(host,long,await invoke(host,'workspace_run',longArgs,long));
  assert.equal(done.result.structuredContent.task.state,'succeeded');assert.equal(await readWorkspace('long.starts'),'once');assert.equal((await broker('operation',{operationId:long.operationId})).starts,1);
  record('running_command_survives_broker_restart_and_reconciles_without_reexecution');
  await run('sudo','-n','-u','anywhere-exec-agent','python3','-c',`from pathlib import Path;Path('${base}/agent/fault.json').write_text('{"point":"agent_before_result"}')`);
  const crashArgs={path:'review.txt',content:'one-effect\n',mode:'append',expectedRevision:null},crash=await host.executor.issue('review-fixture','workspace_write_file',crashArgs);
  const crashing=invoke(host,'workspace_write_file',crashArgs,crash).catch(()=>null);
  await until(async()=>(await run('systemctl','show','--value','-p','ActiveState','anywhere-reliability-agent'))==='failed');
  await svc('start','agent');await ready();await crashing;
  await until(async()=>(await broker('operation',{operationId:crash.operationId})).state==='unknown');
  assert.equal(await readWorkspace('review.txt'),'one-effect');
  await assert.rejects(local('reviewPreview',{operationId:crash.operationId}),/REVOKE_BEFORE_REVIEW/);
  await setMode('revoked');const preview=await local('reviewPreview',{operationId:crash.operationId});
  const decision={requestId:randomUUID(),operationId:crash.operationId,expectedDigest:preview.expectedDigest,disposition:'acknowledge_unknown',note:'Lab fault injection: inspected review.txt and observed one effect; close uncertainty without replay.'};
  await assert.rejects(local('reviewUnknown',{...decision,expectedDigest:'stale'}),/REVIEW_STALE/);
  const reviewed=await local('reviewUnknown',decision);assert.deepEqual(await local('reviewUnknown',decision),reviewed);
  await until(async()=>(await broker('operation',{operationId:crash.operationId})).state==='reviewed');
  assert.ok((await broker('workspace')).blockers.includes(crash.operationId));
  done=await finish(host,crash,await host.client.callTool({name:'workspace_task_status',arguments:{operationId:crash.operationId}}));
  assert.equal(done.result.isError,true);assert.equal(done.result.structuredContent.result.executionOutcome,'unknown');
  assert.equal((await invoke(host,'workspace_write_file',crashArgs,crash)).structuredContent.task.state,'reviewed');
  assert.equal(await readWorkspace('review.txt'),'one-effect');
  record('local_unknown_review_keeps_uncertainty_audit_and_requires_host_consumption_before_unblocking');
  await setMode('read');host=await openHost();await call(host,'workspace_read_file',{path:'source.txt',length:1});
  await setMode('revoked');await until(async()=>!(await broker('workspace')).blockers.length);
  record('new_work_resumes_after_review_and_acknowledgment_without_retrying_original_effect');
  await writeFile('/srv/anywhere-lab/artifacts/reliability-c-retained-state.json',JSON.stringify({broker:await broker('snapshot'),local:await local('status'),historyCount:history.all('results').length,facade:facade.storage()},null,2));
}catch(e){failure=e;console.error(e.stack);}
finally{
  for(const client of clients)await client.close().catch(()=>{});
  await svc('stop','agent','broker').catch(e=>{failure??=e;});
  if(mockStopped)await run('docker','start','anywhere-helper-us-mock-1').catch(e=>{failure??=e;});
  for(const holder of holders)await holder.close().catch(e=>{failure??=e;});
  facade.close();history.close();
  await writeFile('/srv/anywhere-lab/artifacts/reliability-c-integration.json',JSON.stringify({runId,passed:!failure,results,realCli:false,error:failure?.stack??null},null,2));
}
if(failure)process.exitCode=1;
