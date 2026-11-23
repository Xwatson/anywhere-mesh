import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { NetworkClient } from '../../../native/linux/network-helper/client.mjs';
import { control } from '../../execution/control.mjs';

const exec=promisify(execFile),base='/srv/anywhere-lab/reliability-c';
const run=async(...a)=>(await exec(a[0],a.slice(1),{timeout:20000})).stdout.trim();
const broker=(m,p={})=>control(`${base}/broker/control.sock`,m,p);
const local=(m,p={})=>control(`${base}/local/control.sock`,m,p);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const state=async()=>JSON.parse(await run('sudo','-n','python3','-c',`import json,sqlite3,hashlib,pathlib
b=pathlib.Path('${base}');out={}
for role in ['agent','broker']:
 c=sqlite3.connect('file:'+str(b/role/'journal.sqlite')+'?mode=ro',uri=True)
 assert c.execute('PRAGMA quick_check').fetchone()[0]=='ok'
 active=[json.loads(r[0]) for r in c.execute("select value from records where bucket='ops'")]
 archived=[json.loads(r[0]) for r in c.execute("select value from archive_records where bucket='ops'")]
 ops=active+archived
 stable=sorted([{k:o.get(k) for k in ['operationId','requestHash','state','result','reason','starts','lastSeq']} for o in ops],key=lambda o:o['operationId'])
 out[role]=dict(total=len(ops),active=len(active),archived=len(archived),unknown=sum(o['state']=='unknown' for o in ops),reviewed=sum(o['state']=='reviewed' for o in ops),
  immutableDigest=hashlib.sha256(json.dumps(stable,sort_keys=True).encode()).hexdigest(),quickCheck='ok')
 if role=='agent':out['grant']=json.loads(c.execute("select value from records where bucket='meta' and key='workspaceGrant'").fetchone()[0])
for name in ['tickets','mock-history']:
 c=sqlite3.connect('file:'+str(b/'facade'/(name+'.sqlite'))+'?mode=ro',uri=True)
 out[name]=dict(quickCheck=c.execute('PRAGMA quick_check').fetchone()[0])
assert (b/'workspace'/'once.txt').read_text()=='once\\n'
assert (b/'workspace'/'review.txt').read_text()=='one-effect\\n'
out['retainedBackups']=len(list((b/'agent'/'file-backups').glob('*.json')))
out['stagingFiles']=len(list((b/'workspace').rglob('.anywhere-stage-*')))
old=sqlite3.connect('file:/srv/anywhere-lab/workspace-b2/agent/journal.sqlite?mode=ro',uri=True)
out['priorB2Unknown']=[json.loads(r[0])['operationId'] for r in old.execute("select value from records where bucket='ops'") if json.loads(r[0])['state']=='unknown']
print(json.dumps(out))
`));
await run('bash','/srv/anywhere-lab/scripts/guest-guard.sh');
const before=await state(),holders=[];let mockStopped=false,started=false,failure;
try{
  for(const role of ['agent','broker'])assert.equal(await run('systemctl','show','--value','-p','ActiveState',`anywhere-reliability-${role}`),'inactive');
  for(const side of ['cn','us']){const h=await NetworkClient.connect(`/run/anywhere-network/${side}.sock`);holders.push(h);await h.acquire();}
  for(const h of holders)await h.waitConnected(30000);
  assert.equal(JSON.parse(await run('docker','exec','anywhere-helper-cn-probe-1','python','/probe/probe.py')).ok,true);
  await run('docker','stop','-t','2','anywhere-helper-us-mock-1');mockStopped=true;started=true;
  await run('sudo','-n','systemctl','start','anywhere-reliability-broker','anywhere-reliability-agent');
  let info;
  for(let i=0;i<150;i++){try{info=await broker('workspace');}catch{}if(info?.confirmed)break;await sleep(200);}
  assert.equal(info?.confirmed,true);assert.equal(info.grant.mode,'revoked');assert.ok(info.history.device);
  assert.equal((await local('status')).unknownOperations.length,0);
  for(let i=0;i<100;i++){if((await broker('snapshot')).ops.every(o=>o.consumeConfirmed))break;await sleep(100);}
}catch(e){failure=e;}
finally{
  if(started)await run('sudo','-n','systemctl','stop','anywhere-reliability-agent','anywhere-reliability-broker').catch(e=>{failure??=e;});
  if(mockStopped)await run('docker','start','anywhere-helper-us-mock-1').catch(e=>{failure??=e;});
  for(const h of holders)await h.close().catch(e=>{failure??=e;});
}
if(failure)throw failure;
const after=await state();
for(const role of ['agent','broker']){
  assert.equal(after[role].immutableDigest,before[role].immutableDigest);assert.equal(after[role].total,before[role].total);
  assert.ok(after[role].active<=32);assert.ok(after[role].archived>100);assert.equal(after[role].unknown,0);assert.equal(after[role].reviewed,1);
}
assert.deepEqual(after.grant,before.grant);assert.equal(after.grant.mode,'revoked');assert.deepEqual(after.priorB2Unknown,before.priorB2Unknown);assert.equal(after.priorB2Unknown.length,1);
assert.equal(after.stagingFiles,0);assert.ok(after.retainedBackups<=32);
const services={},helpers={};
for(const prefix of ['anywhere-execution','anywhere-dc','anywhere-workspace','anywhere-reliability'])for(const role of ['agent','broker']){
  const unit=`${prefix}-${role}`;services[unit]=await run('systemctl','show','--property=ActiveState,MainPID,UnitFileState',unit);
  assert.match(services[unit],/ActiveState=inactive/);assert.match(services[unit],/MainPID=0/);assert.doesNotMatch(services[unit],/UnitFileState=enabled/);
}
for(const side of ['cn','us']){
  const h=await NetworkClient.connect(`/run/anywhere-network/${side}.sock`);try{helpers[side]=await h.status();}finally{await h.close();}
  assert.equal(helpers[side].phase,'idle');assert.equal(helpers[side].interfacePresent,false);
  assert.doesNotMatch(await run('docker','exec',`anywhere-helper-${side}-1`,'tc','qdisc','show','dev','eth0'),/netem/);
}
const stage0=JSON.parse(await run('docker','exec','anywhere-lab-cn-probe-1','python','/probe/probe.py'));assert.equal(stage0.ok,true);
const web=(await fetch('http://127.0.0.1:3211/')).status;assert.equal(web,200);
const integration=JSON.parse(await readFile('/srv/anywhere-lab/artifacts/reliability-c-integration.json','utf8'));assert.equal(integration.passed,true);assert.equal(integration.results.length,10);
const report={at:new Date().toISOString(),passed:true,realCli:false,restartReconciledWithoutReexecution:true,persisted:after,services,helpers,stage0,labWebHttp:web};
await writeFile('/srv/anywhere-lab/artifacts/reliability-c-final-state.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
