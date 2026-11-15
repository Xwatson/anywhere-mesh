import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NetworkClient } from '../../../native/linux/network-helper/client.mjs';
import { Journal } from '../../execution/journal.mjs';
import { control } from '../../execution/control.mjs';
import { WorkspaceExecutor } from '../executor.mjs';

const exec=promisify(execFile),base='/srv/anywhere-lab/workspace-b2',runId=new Date().toISOString().replace(/\D/g,'');
const run=async(...a)=>(await exec(a[0],a.slice(1),{timeout:40000,maxBuffer:2*1024*1024})).stdout.trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const broker=(method,params={})=>control(`${base}/broker/control.sock`,method,params);
const local=(method,params={})=>control(`${base}/local/control.sock`,method,params);
const svc=(action,...roles)=>run('sudo','-n','systemctl',action,...roles.map(r=>`anywhere-workspace-${r}.service`));
const holders=[],clients=[],results=[];let facade,history,failure,mockStopped=false,relayStopped=false;
const record=(name,detail={})=>{const row={name,passed:true,...detail};results.push(row);console.log(JSON.stringify(row));};
async function until(fn,timeout=40000){const end=Date.now()+timeout;let error;while(Date.now()<end){try{const x=await fn();if(x)return x;}catch(e){error=e;}await sleep(100);}throw new Error('CONDITION_TIMEOUT: '+(error?.message??''));}
const ready=()=>until(async()=>(await broker('workspace')).phase==='ready');
const operation=id=>broker('operation',{operationId:id});
const fileSize=name=>run('sudo','-n','stat','-c','%s',`${base}/workspace/${name}`);
const readWorkspace=name=>run('sudo','-n','-u','anywhere-exec-agent','cat',`${base}/workspace/${name}`);
const content=r=>r.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')??'';
async function setMode(mode,{offline=false}={}){
  const current=await local('status');const p={requestId:randomUUID(),expectedVersion:current.grant.grantVersion,mode};
  const result=await local('setMode',p);assert.equal(result.grant.mode,mode);
  const retried=await local('setMode',p);assert.equal(retried.grant.grantVersion,result.grant.grantVersion);
  if(!offline)await until(async()=>{const i=await broker('workspace');return i.confirmed&&i.grant.grantVersion===result.grant.grantVersion;});
  return result;
}
async function openHost(binding){
  binding??={...(await broker('workspace')).grant,sessionId:'mock-session',turnId:randomUUID(),turnEpoch:1};
  binding=Object.fromEntries(['accountId','deviceId','workspaceId','grantVersion','sessionId','turnId','turnEpoch'].map(k=>[k,binding[k]]));
  const cfg=`${base}/facade/host-${randomUUID()}.json`;
  await writeFile(cfg,JSON.stringify({binding,journalPath:`${base}/facade/tickets.sqlite`,brokerSocket:`${base}/broker/control.sock`}),{mode:0o600});
  const client=new Client({name:'anywhere-mock-host',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:['/usr/lib/anywhere-workspace-runtime/workspace/mcp.mjs',cfg],stderr:'pipe',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}});
  const connecting=client.connect(transport);let stderr='';transport.stderr?.on('data',c=>{if(stderr.length<4096)stderr+=c;});
  await connecting;clients.push(client);
  return{client,binding,executor:new WorkspaceExecutor({journal:facade,binding,control:broker}),diagnostic:()=>stderr};
}
const invoke=(host,name,args,ticket)=>host.client.callTool({name,arguments:args,_meta:{'anywhere/callTicket':ticket.ticket}},undefined,{timeout:30000});
async function consume(host,result){
  const task=result.structuredContent?.task;assert.ok(task?.resultReady,JSON.stringify(result));
  let cursor=0;const output=[];
  while(cursor<task.lastSeq){const page=await host.client.callTool({name:'workspace_task_output',arguments:{operationId:task.operationId,afterSeq:cursor}});assert.ok(!page.isError);output.push(page.structuredContent);assert.ok(page.structuredContent.nextSeq>cursor);cursor=page.structuredContent.nextSeq;}
  const receiptId=`mock-history:${task.operationId}`;
  history.tx(()=>{
    const old=history.get('results',task.operationId);if(old)assert.equal(old.digest,task.resultDigest);
    else history.put('results',task.operationId,{receiptId,digest:task.resultDigest,result,output,committedBeforeAck:true});
  });
  await host.executor.consumeAfterPersist({operationId:task.operationId,resultDigest:task.resultDigest,receiptId});
}
async function call(host,name,args,{expected='succeeded'}={}){
  const ticket=await host.executor.issue(randomUUID(),name,args);let result=await invoke(host,name,args,ticket);
  if(!result.structuredContent?.task?.resultReady) result=await until(async()=>{const r=await host.client.callTool({name:'workspace_task_status',arguments:{operationId:ticket.operationId}});return r.structuredContent?.task?.resultReady&&r;});
  assert.equal(result.structuredContent.task.state,expected,JSON.stringify(result));await consume(host,result);return result;
}
const fixture={
 'source.txt':'初始版本\nHello Workspace\n',
 'package.json':JSON.stringify({name:'workspace-fixture',private:true,type:'module',scripts:{build:'node build.mjs',test:'node --test test.mjs'}}),
 'build.mjs':"import{readFileSync,mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/result.txt',readFileSync('source.txt','utf8').toUpperCase());console.log('BUILD_OK');",
 'test.mjs':"import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';test('output',()=>assert.match(readFileSync('dist/result.txt','utf8'),/HELLO WORKSPACE/));",
 'hold.mjs':"import{appendFileSync}from'node:fs';const file=process.argv[2];appendFileSync(file+'.starts','once\\n');setInterval(()=>{appendFileSync(file,'x');console.log('tick');},100);",
};
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
  await svc('start','broker','agent');await ready();
  assert.equal((await local('status')).grant.mode,'revoked');
  const denied=await openHost();assert.equal((await denied.client.listTools()).tools.length,4);
  let r=await denied.client.callTool({name:'workspace_read_file',arguments:{path:'source.txt'}});assert.match(content(r),/CALL_TICKET_REQUIRED/);
  r=await denied.client.callTool({name:'workspace_capabilities',arguments:{mode:'execute'}});assert.equal(r.isError,true);
  assert.equal((await local('status')).grant.grantVersion,1);
  record('default_deny_and_model_cannot_issue_tickets_or_change_local_permission');
  await setMode('read');const read=await openHost();assert.equal((await read.client.listTools()).tools.length,9);
  assert.equal((await denied.client.listTools()).tools.length,4);
  await assert.rejects(read.executor.issue('forbidden','workspace_run',{command:'true'}),/CAPABILITY_DENIED/);
  const readTicket=await read.executor.issue('first-read','workspace_read_file',{path:'source.txt'});
  r=await invoke(read,'workspace_read_file',{path:'source.txt'},readTicket);assert.match(content(r),/Hello Workspace/);
  assert.equal((await operation(readTicket.operationId)).delivery,'pending');
  await assert.rejects(read.executor.issue('before-receipt','workspace_read_file',{path:'source.txt'}),/WORKSPACE_RECOVERING/);
  await consume(read,r);record('read_only_catalog_real_file_call_and_host_history_before_consumption_ack');
  r=await invoke(read,'workspace_read_file',{path:'../outside'},readTicket);assert.equal(r.isError,true);
  r=await invoke(read,'workspace_read_file',{path:'source.txt',deviceId:'other'},readTicket);assert.equal(r.isError,true);
  const foreign=await openHost();r=await foreign.client.callTool({name:'workspace_task_status',arguments:{operationId:readTicket.operationId}});assert.match(content(r),/TASK_NOT_BOUND/);
  record('traversal_target_override_and_cross_turn_task_access_denied');
  await setMode('edit');await assert.rejects(read.executor.issue('old-grant','workspace_read_file',{path:'source.txt'}),/GRANT_CHANGED/);
  r=await invoke(read,'workspace_read_file',{path:'source.txt'},readTicket);assert.equal(r.structuredContent.task.state,'succeeded');
  const edit=await openHost();assert.equal((await edit.client.listTools()).tools.length,12);
  const append={path:'once.txt',content:'only-once\n',mode:'append'},ticket=await edit.executor.issue('append','workspace_write_file',append);
  const duplicate=await Promise.all([invoke(edit,'workspace_write_file',append,ticket),invoke(edit,'workspace_write_file',append,ticket)]);
  assert.ok(duplicate.every(x=>x.structuredContent.task.operationId===ticket.operationId));assert.equal((await operation(ticket.operationId)).starts,1);assert.equal(await readWorkspace('once.txt'),'only-once');
  r=await invoke(edit,'workspace_write_file',{...append,content:'twice'},ticket);assert.match(content(r),/CALL_TICKET_MISMATCH/);await consume(edit,duplicate[0]);
  await call(edit,'workspace_edit_file',{path:'source.txt',oldText:'初始版本',newText:'正式接口验证'});
  r=await call(edit,'workspace_search',{path:'.',pattern:'正式接口验证'});assert.match(content(r),/source.txt/);
  record('edit_search_stable_host_call_identity_and_concurrent_mcp_retry_deduplication');
  await setMode('execute');let execute=await openHost();assert.equal((await execute.client.listTools()).tools.length,13);
  await call(execute,'workspace_run',{command:'git init -q && git add source.txt && git -c user.name=WorkspaceLab -c user.email=workspace-lab@example.invalid commit -qm fixture && git status --porcelain && git rev-parse --short HEAD'});
  await call(execute,'workspace_run',{command:'npm run build && npm test'});
  r=await call(execute,'workspace_read_file',{path:'dist/result.txt'});assert.match(content(r),/HELLO WORKSPACE/);
  record('formal_mcp_runs_local_git_build_tests_and_reads_real_artifact');
  const lateArgs={command:'echo forbidden >> revoked-prepared.txt'},late=await execute.executor.issue('late','workspace_run',lateArgs);
  await setMode('read');r=await invoke(execute,'workspace_run',lateArgs,late);assert.equal(r.structuredContent.task.state,'rejected');assert.equal((await operation(late.operationId)).starts,0);await assert.rejects(fileSize('revoked-prepared.txt'));await consume(execute,r);
  record('prepared_old_grant_ticket_cannot_start_after_local_permission_reduction');
  await setMode('execute');execute=await openHost();
  const cancelArgs={command:'node hold.mjs cancelled.txt'},c=await execute.executor.issue('cancel','workspace_run',cancelArgs);
  const cancellable=invoke(execute,'workspace_run',cancelArgs,c);await until(async()=>Number(await fileSize('cancelled.txt'))>2);
  await execute.client.callTool({name:'workspace_task_cancel',arguments:{operationId:c.operationId}});
  r=await cancellable;assert.equal(r.structuredContent.task.state,'cancelled');await consume(execute,r);const stoppedCount=await fileSize('cancelled.txt');await sleep(300);assert.equal(await fileSize('cancelled.txt'),stoppedCount);
  record('explicit_mcp_cancel_waits_for_real_process_termination');
  const revokedArgs={command:'node hold.mjs revoked.txt'},rv=await execute.executor.issue('revoke-running','workspace_run',revokedArgs);
  const revoking=invoke(execute,'workspace_run',revokedArgs,rv);await until(async()=>Number(await fileSize('revoked.txt'))>2);
  await setMode('revoked');r=await revoking;assert.equal(r.structuredContent.task.state,'cancelled');await consume(execute,r);
  const revokedCount=await fileSize('revoked.txt');await sleep(300);assert.equal(await fileSize('revoked.txt'),revokedCount);assert.equal((await execute.client.listTools()).tools.length,4);
  record('local_revocation_cancels_in_flight_command_and_removes_advertised_execution_tools');
  await setMode('execute');execute=await openHost();
  const offlineArgs={command:'node hold.mjs offline.txt'},off=await execute.executor.issue('offline','workspace_run',offlineArgs);
  const offlinePromise=invoke(execute,'workspace_run',offlineArgs,off);await until(async()=>Number(await fileSize('offline.txt'))>2);
  await run('docker','stop','-t','2','anywhere-helper-relay-1');relayStopped=true;await until(async()=>(await broker('workspace')).phase!=='ready',18000);
  const change=await setMode('read',{offline:true});await until(async()=>(await local('status')).pendingCancellations.length===0);
  const offlineCount=await fileSize('offline.txt');await sleep(300);assert.equal(await fileSize('offline.txt'),offlineCount);
  assert.equal((await execute.client.listTools()).tools.length,4);assert.equal((await broker('workspace')).confirmed,false);
  await run('docker','start','anywhere-helper-relay-1');relayStopped=false;await ready();
  r=await offlinePromise;if(!r.structuredContent.task.resultReady)r=await until(async()=>{const x=await execute.client.callTool({name:'workspace_task_status',arguments:{operationId:off.operationId}});return x.structuredContent?.task?.resultReady&&x;});
  assert.equal(r.structuredContent.task.state,'cancelled');assert.equal((await broker('workspace')).grant.grantVersion,change.grant.grantVersion);assert.equal(await readWorkspace('offline.txt.starts'),'once');await consume(execute,r);
  record('offline_domestic_permission_change_applies_immediately_and_reconciles_without_reexecution');
  const savedVersion=(await local('status')).grant.grantVersion;
  await svc('restart','agent');await ready();assert.equal((await local('status')).grant.mode,'read');assert.equal((await local('status')).grant.grantVersion,savedVersion);
  record('permission_version_and_mode_survive_domestic_agent_restart');
  await setMode('execute');execute=await openHost();
  const disconnectArgs={command:'echo once >> mcp-reconnect.txt; sleep 3; echo RECONNECTED'},reconnect=await execute.executor.issue('mcp-restart','workspace_run',disconnectArgs);
  const abandoned=invoke(execute,'workspace_run',disconnectArgs,reconnect).catch(e=>({abandoned:true}));
  await until(async()=>await readWorkspace('mcp-reconnect.txt')==='once');await execute.client.close();await abandoned;
  const resumed=await openHost(execute.binding);r=await invoke(resumed,'workspace_run',disconnectArgs,reconnect);
  assert.equal(r.structuredContent.task.state,'succeeded');assert.equal((await operation(reconnect.operationId)).starts,1);assert.equal(await readWorkspace('mcp-reconnect.txt'),'once');await consume(resumed,r);
  await resumed.executor.consumeAfterPersist({operationId:reconnect.operationId,resultDigest:r.structuredContent.task.resultDigest,receiptId:`mock-history:${reconnect.operationId}`});
  record('mcp_process_restart_replays_same_task_and_lost_consumption_ack_is_idempotent');
  await run('sudo','-n','-u','anywhere-exec-agent','python3','-c',`from pathlib import Path;Path('${base}/agent/fault.json').write_text('{"point":"agent_before_result"}')`);
  const crashArgs={path:'unknown.txt',content:'one-effect\n',mode:'append'},crash=await resumed.executor.issue('crash','workspace_write_file',crashArgs);
  const crashing=invoke(resumed,'workspace_write_file',crashArgs,crash);
  await until(async()=>(await run('systemctl','show','-p','ActiveState','--value','anywhere-workspace-agent.service'))==='failed');
  await svc('start','agent');await ready();r=await crashing;
  if(r.structuredContent?.task?.state!=='unknown')r=await until(async()=>{const x=await resumed.client.callTool({name:'workspace_task_status',arguments:{operationId:crash.operationId}});return x.structuredContent?.task?.state==='unknown'&&x;});
  assert.equal(r.isError,true);assert.equal(r.structuredContent.task.resultReady,false);
  assert.equal((await invoke(resumed,'workspace_write_file',crashArgs,crash)).structuredContent.task.state,'unknown');
  assert.equal(await readWorkspace('unknown.txt'),'one-effect');await assert.rejects(resumed.executor.issue('after-unknown','workspace_read_file',{path:'source.txt'}),/WORKSPACE_RECOVERING/);
  await setMode('revoked');
  record('real_write_crash_exposes_unknown_and_blocks_new_side_effects_through_mcp');
  await writeFile('/srv/anywhere-lab/artifacts/workspace-mcp-retained-state.json',JSON.stringify({broker:await broker('snapshot'),local:await local('status'),historyCount:history.all('results').length},null,2));
}catch(e){failure=e;console.error(e.stack);}
finally{
  for(const c of clients)await c.close().catch(()=>{});
  await svc('stop','agent','broker').catch(e=>{failure??=e;});
  if(relayStopped)await run('docker','start','anywhere-helper-relay-1').catch(e=>{failure??=e;});
  if(mockStopped)await run('docker','start','anywhere-helper-us-mock-1').catch(e=>{failure??=e;});
  for(const h of holders)await h.close().catch(e=>{failure??=e;});
  facade.close();history.close();
  await writeFile('/srv/anywhere-lab/artifacts/workspace-mcp-integration.json',JSON.stringify({runId,passed:!failure,results,realCli:false,error:failure?.stack??null},null,2));
}
if(failure)process.exitCode=1;
