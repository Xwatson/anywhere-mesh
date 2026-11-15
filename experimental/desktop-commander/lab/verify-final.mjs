import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NetworkClient } from '../../../native/linux/network-helper/client.mjs';
const exec=promisify(execFile);
const run=async(...a)=>(await exec(a[0],a.slice(1),{timeout:15000})).stdout.trim();
await run('bash','/srv/anywhere-lab/scripts/guest-guard.sh');
const services={},helpers={};
for(const prefix of ['anywhere-execution','anywhere-dc'])for(const role of ['agent','broker']){
  const unit=`${prefix}-${role}.service`;
  services[unit]=await run('systemctl','show','--property=ActiveState,MainPID,UnitFileState',unit);
  assert.match(services[unit],/MainPID=0/);assert.match(services[unit],/ActiveState=inactive/);assert.doesNotMatch(services[unit],/UnitFileState=enabled/);
}
for(const role of ['cn','us']){
  const h=await NetworkClient.connect(`/run/anywhere-network/${role}.sock`);helpers[role]=await h.status();await h.close();
  assert.equal(helpers[role].phase,'idle');assert.equal(helpers[role].pid,null);assert.equal(helpers[role].interfacePresent,false);
  assert.doesNotMatch(await run('docker','exec',`anywhere-helper-${role}-1`,'tc','qdisc','show','dev','eth0'),/netem/);
}
assert.equal(await run('docker','inspect','-f','{{.State.Running}}','anywhere-helper-us-mock-1'),'true');
const stage0=JSON.parse(await run('docker','exec','anywhere-lab-cn-probe-1','python','/probe/probe.py'));assert.equal(stage0.ok,true);
const web=(await fetch('http://127.0.0.1:3211/')).status;assert.equal(web,200);
const bwrapPermissions=await run('stat','-c','%U:%G %a','/usr/lib/anywhere-dc/bwrap');
assert.equal(bwrapPermissions,'root:anywhere-exec-agent 750');
const patches=JSON.parse(await readFile('/srv/anywhere-lab/desktop-c/vendor-patches.json','utf8'));
for(const p of patches){const data=await readFile(`/srv/anywhere-lab/vendor/desktop-commander-0.3.3/node_modules/@wonderwhy-er/desktop-commander/${p.path}`);assert.equal(createHash('sha256').update(data).digest('hex'),p.afterSha256);}
const snapshot=JSON.parse(await readFile('/srv/anywhere-lab/artifacts/desktop-commander-retained-state.json','utf8'));
const times=snapshot.ops.map(o=>o.result?.tool?.timing?.initMs).filter(x=>typeof x==='number').sort((a,b)=>a-b);
const report={at:new Date().toISOString(),services,helpers,stage0,labWebHttp:web,restoredStageAMock:true,
  netemReset:true,realCli:false,patchedFiles:patches.length,bwrapPermissions,
  dependencies:await run('dpkg-query','-W','-f=${Package} ${Version}\n','bubblewrap','ripgrep'),
  startup:{samples:times.length,minMs:times[0],medianMs:times[Math.floor(times.length/2)],maxMs:times.at(-1)},
  retainedUnknown:snapshot.ops.filter(o=>o.state==='unknown').map(o=>({operationId:o.operationId,reason:o.reason,starts:o.starts}))};
await writeFile('/srv/anywhere-lab/artifacts/desktop-commander-final-state.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
