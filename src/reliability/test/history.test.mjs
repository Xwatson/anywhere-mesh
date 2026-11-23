import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../execution/journal.mjs';
import { LocalAgent, envelopeOf } from '../../execution/agent.mjs';
import { Broker } from '../../execution/broker.mjs';
import { id, summary } from '../../execution/protocol.mjs';
import { compactOperations } from '../../execution/retention.mjs';
import { register } from '../../desktop-commander/adapter.mjs';
import { WorkspaceExecutor } from '../../workspace/executor.mjs';
register();
const identity={accountId:'a',deviceId:'d',workspaceId:'w'};
const workspace={label:'test',reliability:true};
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'reliability-'));
  const a=new Journal(join(dir,'agent.sqlite')),b=new Journal(join(dir,'broker.sqlite')),f=new Journal(join(dir,'facade.sqlite'));
  const agent=new LocalAgent(a,identity,{workspace,stateDir:dir});agent.attach(1);
  agent.control('setMode',{requestId:id(),expectedVersion:1,mode:'read'});
  const broker=new Broker(b,identity,{workspace});broker.grant=agent.grant;broker.phase='ready';
  const binding={...identity,grantVersion:2,sessionId:'s',turnId:'t',turnEpoch:1};
  const executor=new WorkspaceExecutor({journal:f,control:(m,p)=>broker.control(m,p),binding});
  t.after(async()=>{await agent.close();broker.close();a.close();b.close();f.close();rmSync(dir,{recursive:true});});
  return{agent,broker,executor,a,b,f};
}
test('200 settled calls compact across both peers and facade while old replay remains bound',async t=>{
  const {agent,broker,executor,a,b,f}=setup(t);let first;
  for(let i=0;i<200;i++){
    const ticket=await executor.issue(`call-${i}`,'workspace_read_file',{path:'x'});first??=ticket;
    const remote=broker.get(ticket.operationId);agent.start(envelopeOf(remote));
    const op=a.get('ops',ticket.operationId);op.state='succeeded';op.starts=1;op.result={tool:{ok:true,response:{content:[{type:'text',text:`result-${i}`}]}}};a.put('ops',op.operationId,op);
    broker.merge(summary(op));
    const reply=await executor.status(op.operationId);
    await executor.consumeAfterPersist({operationId:op.operationId,resultDigest:reply.structuredContent.task.resultDigest,receiptId:`saved-${i}`});
    agent.handle('consumeResult',{...envelopeOf(op),digest:broker.get(op.operationId).resultDigest},1);
    const local=broker.get(op.operationId);local.consumeConfirmed=true;b.put('ops',op.operationId,local);compactOperations(b,'broker');
  }
  assert.equal(a.all('ops').length,32);assert.equal(b.all('ops').length,32);assert.equal(f.all('calls').length,32);
  assert.ok(a.storage().archivedRecords>=168);assert.ok(b.storage().archivedRecords>=168);
  const replay=await executor.issue('call-0','workspace_read_file',{path:'x'});assert.deepEqual(replay,first);
  const reply=await executor.invoke('workspace_read_file',{path:'x'},first.ticket);assert.equal(reply.content[0].text,'result-0');
  const op=broker.get(first.operationId);assert.equal(agent.start(envelopeOf(op)).starts,1);
  await assert.rejects(executor.issue('call-0','workspace_read_file',{path:'changed'}),/TOOL_CALL_CONFLICT/);
  assert.equal(a.all('ops').length,32);
});
test('compaction preserves unknown and unconsumed evidence, and archived writes stay archived',t=>{
  const {a}=setup(t);
  const request={scope:{...identity,sessionId:'s',turnId:'t',turnEpoch:1},toolCallId:'x'};
  a.put('ops','unknown',{operationId:'unknown',state:'unknown',request});
  a.put('ops','pending',{operationId:'pending',state:'succeeded',request,resultConsumed:false});
  for(let i=0;i<40;i++)a.put('ops',`settled-${i}`,{operationId:`settled-${i}`,state:'succeeded',request,resultConsumed:true});
  compactOperations(a,'agent');assert.ok(a.all('ops').some(o=>o.state==='unknown'));assert.ok(a.all('ops').some(o=>o.operationId==='pending'));
  const archived=a.get('ops','settled-0');archived.extra='updated';a.put('ops','settled-0',archived);
  assert.equal(a.get('ops','settled-0').extra,'updated');assert.ok(!a.all('ops').some(o=>o.operationId==='settled-0'));
});
test('unknown review requires local revocation, a current digest and durable idempotent decision',async t=>{
  const {agent,broker,executor,a}=setup(t),ticket=await executor.issue('unknown','workspace_read_file',{path:'x'});
  agent.start(envelopeOf(broker.get(ticket.operationId)));const op=a.get('ops',ticket.operationId);op.state='unknown';op.reason='injected';op.starts=1;a.put('ops',op.operationId,op);broker.merge(summary(op));
  assert.throws(()=>agent.control('reviewPreview',{operationId:op.operationId}),/REVOKE_BEFORE_REVIEW/);
  agent.control('setMode',{requestId:id(),expectedVersion:2,mode:'revoked'});
  const preview=agent.control('reviewPreview',{operationId:op.operationId});
  const params={requestId:id(),operationId:op.operationId,expectedDigest:preview.expectedDigest,disposition:'acknowledge_unknown',note:'Inspected fixture; outcome remains uncertain.'};
  assert.throws(()=>agent.handle('reviewUnknown',params,1),/METHOD_NOT_FOUND/);
  assert.throws(()=>agent.control('reviewUnknown',{...params,expectedDigest:'stale'}),/REVIEW_STALE/);
  const decision=agent.control('reviewUnknown',params);assert.equal(decision.state,'reviewed');assert.deepEqual(agent.control('reviewUnknown',params),decision);
  assert.throws(()=>agent.control('reviewUnknown',{...params,note:'different'}),/REVIEW_CONFLICT/);
  const reviewed=a.get('ops',op.operationId);broker.merge(summary(reviewed));assert.equal(broker.blockers('w').length,1);
  const reply=await executor.status(op.operationId);assert.equal(reply.isError,true);assert.equal(reply.structuredContent.result.executionOutcome,'unknown');
  await executor.consumeAfterPersist({operationId:op.operationId,resultDigest:reply.structuredContent.task.resultDigest,receiptId:'history'});
  assert.equal(broker.blockers('w').length,0);assert.equal(agent.start(envelopeOf(reviewed)).starts,1);
  assert.equal(reviewed.result.review.original.state,'unknown');
});
test('local review cannot close an operation whose process is still supervised',async t=>{
  const {agent,executor,broker,a}=setup(t),ticket=await executor.issue('running','workspace_read_file',{path:'x'});
  agent.start(envelopeOf(broker.get(ticket.operationId)));const op=a.get('ops',ticket.operationId);op.state='unknown';a.put('ops',op.operationId,op);
  agent.control('setMode',{requestId:id(),expectedVersion:2,mode:'revoked'});
  agent.children.set(op.operationId,{});
  assert.throws(()=>agent.control('reviewPreview',{operationId:op.operationId}),/PROCESS_STILL_ACTIVE/);
  agent.children.delete(op.operationId);
});
test('archival rollback is atomic and stopping an archived turn restores the pending stop',async t=>{
  const {b,broker}=setup(t),scope={...identity,sessionId:'s',turnId:'old',turnEpoch:1,grantVersion:2};
  const key=JSON.stringify(['s','old',1]);b.put('turns',key,{scope,stopped:false,reasoning:'idle'});
  assert.throws(()=>b.tx(()=>{b.archive('turns',key);throw Error('crash');}),/crash/);
  assert.equal(b.all('turns').length,1);
  b.tx(()=>b.archive('turns',key));assert.equal(b.all('turns').length,0);
  await broker.control('stopTurn',{sessionId:'s',turnId:'old',turnEpoch:1});
  assert.equal(b.all('turns').length,1);assert.equal(b.get('turns',key).stopped,true);assert.equal(b.get('turns',key).stopConfirmed,undefined);
});
test('domestic history admission exhaustion is a durable rejection with zero starts',async t=>{
  const {agent,executor,broker,a}=setup(t),ticket=await executor.issue('quota','workspace_read_file',{path:'x'});
  a.maxHistoryBytes=1;
  const result=agent.start(envelopeOf(broker.get(ticket.operationId)));
  assert.equal(result.state,'rejected');assert.equal(result.reason,'HISTORY_STORAGE_FULL');assert.equal(result.starts,0);
  assert.equal(agent.start(envelopeOf(broker.get(ticket.operationId))).state,'rejected');
  agent.control('setMode',{requestId:id(),expectedVersion:2,mode:'revoked'});assert.equal(agent.grant.revoked,true);
});
