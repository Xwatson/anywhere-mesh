import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { NetworkClient } from '../../../native/linux/network-helper/client.mjs';
import { control } from '../../execution/control.mjs';
const exec = promisify(execFile), base='/srv/anywhere-lab/desktop-c';
const run=async(...a)=>(await exec(a[0],a.slice(1),{timeout:45000,maxBuffer:2*1024*1024})).stdout.trim();
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const ctrl=(method,params={})=>control(`${base}/broker/control.sock`,method,params);
const svc=(action,...roles)=>run('sudo','-n','systemctl',action,...roles.map(r=>`anywhere-dc-${r}.service`));
const results=[],holders=[],runId=new Date().toISOString().replace(/\D/g,'');
let failure,mockStopped=false,relayStopped=false;
const record=(name,details={})=>{const row={name,passed:true,...details};results.push(row);console.log(JSON.stringify(row));};
async function until(fn,timeout=45000){const end=Date.now()+timeout;let error;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){error=e;}await sleep(100);}throw new Error('CONDITION_TIMEOUT: '+(error?.message??''));}
const snapshot=()=>ctrl('snapshot');
const ready=()=>until(async()=>(await snapshot()).phase==='ready');
const get=async(id)=>(await snapshot()).ops.find(o=>o.operationId===id);
const finished=(id)=>until(async()=>{const o=await get(id);return o&&['succeeded','failed','cancelled','rejected','unknown'].includes(o.state)&&o.receivedSeq===o.lastSeq&&o;},90000);
const ack=(o)=>ctrl('ackResult',{operationId:o.operationId,digest:o.resultDigest,stage:'consumed'});
const params=(kind,args,cwdRelative='.')=>({sessionId:randomUUID(),turnId:randomUUID(),turnEpoch:1,toolCallId:randomUUID(),kind,args,cwdRelative,expiresAt:Date.now()+120000});
const txt=(o)=>o.result?.tool?.response?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')??'';
async function task(kind,args,{expected='succeeded',cwd='.'}={}){const p=params(kind,args,cwd);const sent=await ctrl('submit',p);const o=await finished(sent.operationId);assert.equal(o.state,expected,JSON.stringify(o.result));await ack(o);return o;}
const tool=(name,args,options)=>task('dc.tool',{tool:name,arguments:args},options);
const readWorkspace=(file)=>run('sudo','-n','-u','anywhere-exec-agent','cat',`${base}/workspace/${file}`);
const fileSize=(file)=>run('sudo','-n','stat','-c','%s',`${base}/workspace/${file}`);
const fixture={
  'package.json':JSON.stringify({name:'dc-fixture',private:true,type:'module',scripts:{build:'node build.mjs',test:'node --test test.mjs'}}),
  'source.txt':'跨境工具验证\r\nHello World\r\n',
  'build.mjs':"import{readFileSync,mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/result.txt',readFileSync('source.txt','utf8').toUpperCase());console.log('BUILD_OK');",
  'test.mjs':"import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';test('built artifact',()=>assert.match(readFileSync('dist/result.txt','utf8'),/HELLO WORLD/));",
  'escape.mjs':"import{appendFileSync}from'node:fs';setInterval(()=>appendFileSync('/workspace/escaped-effects.txt','x'),50);",
  'long.mjs':"import{appendFileSync}from'node:fs';appendFileSync('long-starts.txt','once\\n');let i=0;const t=setInterval(()=>{console.log('tick-'+(++i));if(i===32)clearInterval(t);},1000);",
  'boundary.mjs':`import fs from 'node:fs';import net from 'node:net';import assert from 'node:assert/strict';
for(const p of ['/etc/anywhere-execution/agent/self.key','/run/anywhere-network/cn.sock','/srv/anywhere-lab/source','/home/lab/.ssh','/vol1'])assert.equal(fs.existsSync(p),false,p);
assert.equal(process.env.ANYWHERE_CODING,undefined);assert.equal(process.env.ANTHROPIC_API_KEY,undefined);assert.equal(process.env.OPENAI_API_KEY,undefined);
assert.throws(()=>fs.writeFileSync('/usr/local/bin/dc-escape','x'),/EROFS|EACCES/);
const pids=fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x));assert.ok(pids.length<20);
await new Promise((resolve,reject)=>{const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(1200,()=>{s.destroy();resolve()});s.on('connect',()=>{s.destroy();reject(new Error('NETWORK_ESCAPE'))});s.on('error',resolve)});
console.log('BOUNDARY_OK pids='+pids.length);`,
};
await run('bash','/srv/anywhere-lab/scripts/guest-guard.sh');
await svc('stop','agent','broker');
// Preserve every previous run, including unknown journals and fixture effects.
await run('sudo','-n','python3','-c',`import pathlib,os,pwd,grp,shutil,json,sys
b=pathlib.Path('${base}');a=b/'archive'/'${runId}';a.mkdir(parents=True)
for name in ['agent','broker','workspace']:
 p=b/name
 if p.exists():shutil.move(str(p),str(a/name))
 p.mkdir();u='anywhere-exec-broker' if name=='broker' else 'anywhere-exec-agent';g='lab' if name=='broker' else u
 os.chown(p,pwd.getpwnam(u).pw_uid,grp.getgrnam(g).gr_gid);p.chmod(0o750 if name=='broker' else 0o700)
for name,content in json.loads(sys.argv[1]).items():
 p=b/'workspace'/name;p.write_bytes(content.encode());os.chown(p,pwd.getpwnam('anywhere-exec-agent').pw_uid,grp.getgrnam('anywhere-exec-agent').gr_gid);p.chmod(0o600)
`,JSON.stringify(fixture));
try{
  for(const role of ['cn','us']){const h=await NetworkClient.connect(`/run/anywhere-network/${role}.sock`);holders.push(h);await h.acquire();}
  for(const h of holders)await h.waitConnected(30000);
  await run('docker','stop','-t','2','anywhere-helper-us-mock-1');mockStopped=true;
  await svc('start','broker','agent');await ready();
  for(const role of ['agent','broker']){
    const pid=await run('systemctl','show','-p','MainPID','--value',`anywhere-dc-${role}.service`);
    const status=await readFile(`/proc/${pid}/status`,'utf8');assert.match(status,/CapEff:\s+0000000000000000/);assert.match(status,/NoNewPrivs:\s+1/);assert.doesNotMatch(status,/Uid:\s+0\s/);
  }
  const discovered=await task('dc.inspect',{});assert.equal(discovered.result.tool.server.version,'0.3.3');
  await writeFile('/srv/anywhere-lab/artifacts/desktop-commander-tools.json',JSON.stringify(discovered.result.tool,null,2));
  record('real_mcp_handshake_and_discovery_inside_nonroot_sandbox',{tools:discovered.result.tool.tools.length,timing:discovered.result.tool.timing});
  await tool('create_directory',{path:'中文目录'});
  await tool('write_file',{path:'中文目录/笔记.txt',content:'第一行\r\n第二行\r\n',mode:'rewrite'});
  let o=await tool('read_file',{path:'中文目录/笔记.txt',offset:1,length:1});assert.match(txt(o),/第二行/);
  o=await tool('read_multiple_files',{paths:['source.txt','中文目录/笔记.txt']});assert.match(txt(o),/Hello World/);assert.match(txt(o),/第一行/);
  o=await tool('list_directory',{path:'.',depth:2});assert.match(txt(o),/笔记/);
  o=await tool('get_file_info',{path:'source.txt'});assert.match(txt(o),/size|Size/);
  record('unicode_paths_read_write_multi_read_pagination_directory_and_metadata');
  const p=params('dc.tool',{tool:'write_file',arguments:{path:'once.txt',content:'only-once\n',mode:'append'}});
  const replies=await Promise.all([ctrl('submit',p),ctrl('submit',p),ctrl('submit',p)]);assert.ok(replies.every(x=>x.operationId===replies[0].operationId));
  o=await finished(replies[0].operationId);assert.equal(o.state,'succeeded');assert.equal(o.starts,1);assert.equal(await readWorkspace('once.txt'),'only-once');
  await assert.rejects(ctrl('submit',{...p,args:{...p.args,arguments:{...p.args.arguments,content:'changed'}}}),/TOOL_CALL_CONFLICT/);await ack(o);
  record('durable_dedup_prevents_duplicate_append_and_rejects_changed_arguments');
  await tool('edit_block',{file_path:'source.txt',old_string:'Hello World',new_string:'Hello World updated',expected_replacements:1});
  assert.match(await readWorkspace('source.txt'),/Hello World updated/);
  await tool('write_file',{path:'ambiguous.txt',content:'same\nsame\n',mode:'rewrite'});
  o=await tool('edit_block',{file_path:'ambiguous.txt',old_string:'same',new_string:'different',expected_replacements:1},{expected:'failed'});
  assert.equal(await readWorkspace('ambiguous.txt'),'same\nsame');
  await tool('edit_block',{file_path:'ambiguous.txt',old_string:'not-present-at-all',new_string:'changed',expected_replacements:1},{expected:'failed'});
  await tool('read_file',{path:'does-not-exist.txt'},{expected:'failed'});
  o=await tool('read_multiple_files',{paths:['source.txt','does-not-exist.txt']},{expected:'failed'});
  assert.equal(o.result.tool.response.structuredContent.errors.length,1);
  record('edit_block_and_explicit_ambiguous_edit_and_missing_file_errors');
  o=await task('dc.search',{path:'.',pattern:'跨境工具验证',searchType:'content',literalSearch:true,maxResults:10});
  assert.match(txt(o),/source.txt/);assert.equal(o.result.tool.response.structuredContent.isComplete,true);
  record('async_ripgrep_search_finishes_within_one_durable_operation');
  for(const a of [{tool:'read_file',arguments:{path:'../../etc/passwd'}},{tool:'set_config_value',arguments:{key:'allowedDirectories',value:['/']}}])await assert.rejects(ctrl('submit',params('dc.tool',a)),/PATH_DENIED|TOOL_DENIED/);
  await task('dc.run',{command:'ln -s /etc/anywhere-execution/agent/self.key escape-link'});
  await tool('read_file',{path:'escape-link'},{expected:'failed'});
  o=await task('dc.run',{command:'node boundary.mjs'});
  const output=await ctrl('output',{operationId:o.operationId,afterSeq:0});assert.match(JSON.stringify(output),/BOUNDARY_OK/);
  record('path_config_symlink_credentials_network_pid_and_runtime_write_boundaries');
  o=await task('dc.run',{command:'npm run build && npm test'});assert.match(await readWorkspace('dist/result.txt'),/HELLO WORLD UPDATED/);
  record('real_offline_node_build_and_tests',{timing:o.result.tool.timing});
  o=await task('dc.run',{command:`node -e "console.log('Process completed with exit code 0');process.exit(7)"`},{expected:'failed'});assert.equal(o.result.tool.process.exitCode,7);
  record('structured_nonzero_exit_is_not_spoofed_by_process_output');
  o=await task('dc.run',{command:`node -e "process.stdin.once('data',d=>{console.log('INPUT:'+d.toString().trim());process.exit(0)})"`,input:'hello-input'});
  assert.match(JSON.stringify(await ctrl('output',{operationId:o.operationId,afterSeq:0})),/hello-input/);
  record('bounded_stdin_interaction');
  // The read-only mode is a mount rule: shell commands cannot bypass it.
  const ro=JSON.parse(await run('sudo','-n','python3','-c',`import subprocess,json,pathlib,sys
p=json.loads(sys.argv[1]);r=subprocess.run(['sudo','-n','-u','anywhere-exec-agent','bash','-c','/usr/local/bin/node /usr/lib/anywhere-dc-runtime/desktop-commander/worker.mjs 3>${base}/agent/readonly-result.json'],input=json.dumps(p),text=True,capture_output=True,timeout=35)
print(pathlib.Path('${base}/agent/readonly-result.json').read_text())`,JSON.stringify({request:{kind:'dc.run',cwdRelative:'.',args:{command:'echo forbidden > readonly-test.txt'}},profile:{workspaceRoot:`${base}/workspace`,readOnly:true}})));
  assert.equal(ro.ok,false);assert.notEqual(ro.process.exitCode,0);
  await assert.rejects(fileSize('readonly-test.txt'));record('read_only_mount_blocks_shell_writes');
  const cancel=await ctrl('submit',params('dc.run',{command:'setsid node /workspace/escape.mjs </dev/null >/dev/null 2>&1 & echo CHILD_STARTED; sleep 60'}));
  await until(async()=>Number(await fileSize('escaped-effects.txt'))>3);
  await ctrl('cancel',{operationId:cancel.operationId});o=await finished(cancel.operationId);assert.equal(o.state,'cancelled');
  const count=await fileSize('escaped-effects.txt');await sleep(700);assert.equal(await fileSize('escaped-effects.txt'),count);await ack(o);
  record('cancel_kills_setsided_grandchild_using_pid_namespace');
  const long=await ctrl('submit',params('dc.run',{command:'node long.mjs'}));
  await until(async()=>(await get(long.operationId)).lastSeq>0);
  await run('docker','stop','-t','2','anywhere-helper-relay-1');relayStopped=true;
  await until(async()=>(await snapshot()).phase!=='ready',18000);
  await svc('restart','broker');
  await run('docker','start','anywhere-helper-relay-1');relayStopped=false;
  await ready();o=await finished(long.operationId);assert.equal(o.state,'succeeded');assert.equal(o.starts,1);assert.equal(await readWorkspace('long-starts.txt'),'once');assert.equal(o.receivedSeq,o.lastSeq);await ack(o);
  record('relay_outage_and_broker_restart_reconcile_real_command_without_reexecution',{lastSeq:o.lastSeq});
  o=await task('dc.run',{command:`node -e "for(let i=0;i<4000;i++)console.log('row-'+i+'-'+ 'x'.repeat(100))"`});
  const logs=await ctrl('output',{operationId:o.operationId,afterSeq:0});assert.ok(logs.truncatedThrough>0||o.gaps.length>0);
  record('large_command_output_is_bounded_and_truncation_is_explicit',{gaps:o.gaps.length,lastSeq:o.lastSeq});
  await run('sudo','-n','-u','anywhere-exec-agent','python3','-c',`from pathlib import Path;Path('${base}/agent/fault.json').write_text('{"point":"agent_before_result"}')`);
  const crashArgs=params('dc.tool',{tool:'write_file',arguments:{path:'crash-once.txt',content:'one-effect\n',mode:'append'}});
  const crash=await ctrl('submit',crashArgs);
  await until(async()=>(await run('systemctl','show','-p','ActiveState','--value','anywhere-dc-agent.service'))==='failed');
  await svc('start','agent');await ready();
  o=await until(async()=>{const x=await get(crash.operationId);return x.state==='unknown'&&x;});
  assert.equal(await readWorkspace('crash-once.txt'),'one-effect');assert.equal((await ctrl('submit',crashArgs)).state,'unknown');
  await assert.rejects(ctrl('submit',params('dc.tool',{tool:'read_file',arguments:{path:'source.txt'}})),/WORKSPACE_RECOVERING/);
  await writeFile('/srv/anywhere-lab/artifacts/desktop-commander-retained-state.json',JSON.stringify(await snapshot(),null,2));
  record('agent_crash_after_real_write_retains_unknown_and_blocks_automatic_retry');
}catch(e){failure=e;console.error(e.stack);}
finally{
  await svc('stop','agent','broker').catch(e=>{failure??=e;});
  if(relayStopped)await run('docker','start','anywhere-helper-relay-1').catch(e=>{failure??=e;});
  if(mockStopped)await run('docker','start','anywhere-helper-us-mock-1').catch(e=>{failure??=e;});
  for(const h of holders)await h.close().catch(e=>{failure??=e;});
  await writeFile('/srv/anywhere-lab/artifacts/desktop-commander-integration.json',JSON.stringify({runId,passed:!failure,results,error:failure?.stack??null,realCli:false},null,2));
}
if(failure)process.exitCode=1;
