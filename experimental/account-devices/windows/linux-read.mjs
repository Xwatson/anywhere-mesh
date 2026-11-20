// Run as lab in the Ubuntu client VM. Call through an already signed-in Linux device.
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { control } from '/usr/lib/anywhere-d3-runtime/experimental/execution/control.mjs';
const proof = JSON.parse(Buffer.from(process.argv[2],'base64url'));
assert.match(proof.file,/^verify-[a-f0-9-]{36}\.txt$/);
const {sessionId,workspaceId,deviceId}=proof;
let caller,source;
for (const slot of ['a','b']) {
  const run=(m,p)=>control('/srv/anywhere-lab/wan/local/'+slot+'/control.sock',m,p);
  const state=await run('state');
  if (state.user?.username==='lab-coder' && state.deviceId!==deviceId) { caller=run;source=state;break; }
}
assert.ok(caller,'A signed-in Linux lab-coder installation is required');
const target=source.sessions.find(s=>s.id===sessionId);
assert.equal(target?.workspaceId,workspaceId);assert.equal(target.deviceId,deviceId);
assert.ok(source.devices.find(d=>d.id===deviceId)?.online);
await assert.rejects(caller('permission',{workspaceId,mode:'read'}),/ONLY_ON_BOUND_DEVICE/);
await assert.rejects(caller('send',{sessionId,requestId:randomUUID(),text:'/append '+proof.file+' denied'}),/LOCAL_PERMISSION_REQUIRED/);
const send=()=>caller('send',{sessionId,requestId:randomUUID(),text:'/read '+proof.file});
const receipt=await send();
assert.equal(receipt.workspaceId,workspaceId);
let cursor=target.lastSeq, verified=false;
const deadline=Date.now()+85000;
while(!verified && Date.now()<deadline){
  const page=await caller('history',{sessionId,afterSeq:cursor});
  assert.equal(page.workspaceId,workspaceId);
  for(const row of page.events){
    const event=row.event;
    if(event.type!=='tool_call'||event.id!==receipt.turnId||event.status!=='completed') continue;
    assert.equal(event.name,'workspace_read_file');
    const marker=event.output.match(/WINDOWS_LOCAL_[a-f0-9-]{36}/)?.[0];
    assert.ok(marker);assert.equal(createHash('sha256').update(marker).digest('hex'),proof.secondDigest);
    verified=true;
  }
  cursor=page.throughSeq;
  if(!verified)await delay(400);
}
assert.ok(verified,'Original Windows file did not supply the second read');
let offline=false;
const end=Date.now()+60000;
do {
  const state=await caller('state');
  offline=state.devices.find(d=>d.id===deviceId)?.online===false;
  if(!offline)await delay(500);
} while(!offline&&Date.now()<end);
assert.ok(offline,'Windows sign-out should show the device offline');
await assert.rejects(send(),/DEVICE_OFFLINE/);
console.log(JSON.stringify({sourceDevice:source.localName,sourceDeviceId:source.deviceId,targetDeviceId:deviceId,
  sessionId,readTurn:receipt.turnId,freshContentVerified:true,otherDeviceGrantDenied:true,readOnlyWriteDenied:true,offlineSendDenied:true}));
