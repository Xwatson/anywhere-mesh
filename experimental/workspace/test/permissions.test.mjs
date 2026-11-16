import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../execution/journal.mjs';
import { LocalAgent } from '../../execution/agent.mjs';
import { Broker } from '../../execution/broker.mjs';
import { GrantAuthority } from '../../execution/grants.mjs';
import { id, hash } from '../../execution/protocol.mjs';
import { register } from '../../desktop-commander/adapter.mjs';
import { normalize, listTools } from '../catalog.mjs';
register();
const identity={accountId:'a',deviceId:'d',workspaceId:'w'};
const options={workspace:{label:'test'},stateDir:'/tmp'};
function store(t){const path=mkdtempSync(join(tmpdir(),'workspace-policy-'));const j=new Journal(join(path,'state.sqlite'));t.after(()=>{j.close();rmSync(path,{recursive:true});});return j;}
const change=(agent,mode)=>agent.control('setMode',{requestId:id(),expectedVersion:agent.grant.grantVersion,mode});
function envelope(agent, args={tool:'read_file',arguments:{path:'x'}}){const request={scope:{...identity,grantVersion:agent.grant.grantVersion,sessionId:'s',turnId:id(),turnEpoch:1},toolCallId:id(),kind:'dc.tool',args,cwdRelative:'.',expiresAt:Date.now()+10000};return{operationId:id(),requestHash:hash(request),request};}
test('initial deny, version compare-and-swap and durable idempotent permission decisions',t=>{
  const j=store(t),p=new GrantAuthority(j,identity);assert.equal(p.current.mode,'revoked');
  const request={requestId:'first',expectedVersion:1,mode:'edit'};assert.equal(p.change(request).grantVersion,2);
  assert.equal(p.change(request).grantVersion,2);
  assert.throws(()=>p.change({...request,mode:'execute'}),/GRANT_CHANGE_CONFLICT/);
  assert.throws(()=>p.change({...request,requestId:'second'}),/GRANT_VERSION_CONFLICT/);
  assert.equal(new GrantAuthority(j,identity).current.mode,'edit');
});
test('authorization history compacts beyond 64 changes and storage exhaustion still permits revocation',t=>{
  const j=store(t),p=new GrantAuthority(j,identity);
  const early={requestId:id(),expectedVersion:1,mode:'execute'};p.change(early);
  while(p.current.grantVersion<200)p.change({requestId:id(),expectedVersion:p.current.grantVersion,mode:'execute'});
  assert.equal(p.historical(2).mode,'execute');assert.equal(p.change(early).grantVersion,2);assert.equal(p.current.grantVersion,200);
  assert.equal(j.all('grants').length,32);assert.ok(j.storage().archivedRecords>100);
  j.maxHistoryBytes=1;
  assert.throws(()=>p.change({requestId:id(),expectedVersion:200,mode:'edit'}),/HISTORY_STORAGE_FULL/);
  const revoke={requestId:id(),expectedVersion:200,mode:'revoked'};
  assert.equal(p.change(revoke).grantVersion,201);assert.equal(p.change(revoke).mode,'revoked');
  assert.equal(new GrantAuthority(j,identity).current.revoked,true);
  assert.throws(()=>p.change({requestId:id(),expectedVersion:201,mode:'execute'}),/HISTORY_STORAGE_FULL/);
  assert.equal(j.all('grants').length,32);
});
test('accepted work is cancelled by local revocation before its deferred launch',async t=>{
  const j=store(t),agent=new LocalAgent(j,identity,options);change(agent,'edit');const req=envelope(agent);
  agent.start(req);change(agent,'revoked');assert.equal(j.get('ops',req.operationId).state,'cancelled');
  await new Promise(r=>setTimeout(r,20));assert.equal(j.get('ops',req.operationId).starts,0);
  assert.equal(agent.start(req).state,'cancelled');await agent.close();
});
test('delayed old-version invocation is durably rejected, and old history remains queryable',async t=>{
  const j=store(t),agent=new LocalAgent(j,identity,options);agent.attach(1);change(agent,'edit');const req=envelope(agent);
  change(agent,'read');assert.equal(agent.start(req).state,'rejected');
  change(agent,'revoked');assert.equal(agent.handle('status',req,1).state,'rejected');
  assert.equal(agent.cancel({...req,cancelId:id()}).state,'rejected');
  const bad=structuredClone(req);bad.request.scope.deviceId='foreign';bad.requestHash=hash(bad.request);
  assert.throws(()=>agent.handle('status',bad,1),/SCOPE_DENIED/);await agent.close();
});
test('read/edit/execute advertise distinct capabilities and model fields cannot choose a target',t=>{
  const agent=new LocalAgent(store(t),identity,options);
  change(agent,'read');assert.equal(listTools(agent.grant).length,9);assert.ok(!listTools(agent.grant).some(t=>t.name==='workspace_run'));
  change(agent,'edit');assert.equal(listTools(agent.grant).length,12);
  change(agent,'execute');assert.equal(listTools(agent.grant).length,13);
  for(const args of [{path:'../secret'},{path:'x',workspaceId:'other'},{path:'x',isUrl:true}])assert.throws(()=>normalize('workspace_read_file',args));
  assert.throws(()=>normalize('workspace_write_file',{path:'x',content:'x'}),/MISSING_ARGUMENT/);
});
test('permission retry cannot roll current mode back',t=>{
  const agent=new LocalAgent(store(t),identity,options),first={requestId:id(),expectedVersion:1,mode:'execute'};
  agent.control('setMode',first);change(agent,'revoked');
  const reply=agent.control('setMode',first);assert.equal(reply.decisionVersion,2);assert.equal(reply.grant.mode,'revoked');assert.equal(reply.grant.grantVersion,3);
});
test('broker requires the host grant version and reserves one prepared task per workspace',t=>{
  const j=store(t),agent=new LocalAgent(j,identity,options);change(agent,'read');
  const broker=new Broker(j,identity,{workspace:{label:'test'}});broker.grant=agent.grant;broker.phase='ready';t.after(()=>broker.close());
  const request={sessionId:'s',turnId:'t',turnEpoch:1,toolCallId:'one',kind:'dc.tool',args:{tool:'read_file',arguments:{path:'x'}},cwdRelative:'.',expiresAt:Date.now()+10000};
  assert.throws(()=>broker.prepare(request),/GRANT_CHANGED/);
  const op=broker.prepare({...request,expectedGrantVersion:2});assert.equal(op.state,'prepared');
  assert.throws(()=>broker.prepare({...request,toolCallId:'two',expectedGrantVersion:2}),/EXECUTOR_BUSY/);
});
