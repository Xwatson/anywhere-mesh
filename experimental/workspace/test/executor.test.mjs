import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../execution/journal.mjs';
import { Broker } from '../../execution/broker.mjs';
import { id, resultDigest } from '../../execution/protocol.mjs';
import { grantFor } from '../../execution/grants.mjs';
import { register } from '../../desktop-commander/adapter.mjs';
import { WorkspaceExecutor } from '../executor.mjs';
import { createWorkspaceMcp } from '../mcp.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
register();
const binding={accountId:'a',deviceId:'d',workspaceId:'w',grantVersion:2,sessionId:'s',turnId:'t',turnEpoch:1};
function setup(t){
  const path=mkdtempSync(join(tmpdir(),'workspace-mcp-')),brokerJournal=new Journal(join(path,'broker.sqlite')),facade=new Journal(join(path,'facade.sqlite'));
  const broker=new Broker(brokerJournal,binding,{workspace:{label:'Test'}});broker.grant=grantFor(binding,'execute',2);broker.phase='ready';
  const control=(method,params)=>broker.control(method,params);
  const executor=new WorkspaceExecutor({journal:facade,binding,control});
  t.after(()=>{broker.close();brokerJournal.close();facade.close();rmSync(path,{recursive:true});});
  return{broker,facade,executor,control};
}
test('host ticket is stable, binds arguments and recovers a prepare response lost before local commit',async t=>{
  const {executor,facade}=setup(t),args={path:'hello.txt',content:'once',mode:'append',expectedRevision:null};
  const [first,concurrent]=await Promise.all([executor.issue('call','workspace_write_file',args),executor.issue('call','workspace_write_file',args)]);
  assert.deepEqual(first,concurrent);
  const key=executor.key('call'),record=facade.get('calls',key);record.operationId=null;facade.put('calls',key,record);
  assert.deepEqual(await executor.issue('call','workspace_write_file',args),first);
  await assert.rejects(executor.issue('call','workspace_write_file',{...args,content:'twice'}),/TOOL_CALL_CONFLICT/);
  await assert.rejects(executor.invoke('workspace_write_file',{...args,content:'twice'},first.ticket),/CALL_TICKET_MISMATCH/);
});
test('task binding and query index commit atomically and recover without another operation',async t=>{
  const {executor,facade,broker}=setup(t),args={path:'x'},put=facade.put.bind(facade);
  facade.put=(bucket,key,value)=>{if(bucket==='operations')throw new Error('INDEX_WRITE_FAILED');return put(bucket,key,value);};
  await assert.rejects(executor.issue('interrupted','workspace_read_file',args),/INDEX_WRITE_FAILED/);
  assert.equal(facade.get('calls',executor.key('interrupted')).operationId,null);
  const original=broker.journal.all('ops');assert.equal(original.length,1);
  facade.put=put;
  const ticket=await executor.issue('interrupted','workspace_read_file',args);
  assert.equal(ticket.operationId,original[0].operationId);
  assert.equal((await executor.status(ticket.operationId)).structuredContent.task.state,'prepared');
  assert.equal(broker.journal.all('ops').length,1);
});
test('task queries and ticket use cannot cross a trusted turn binding',async t=>{
  const {executor,facade,control}=setup(t),ticket=await executor.issue('call','workspace_read_file',{path:'x'});
  const other=new WorkspaceExecutor({journal:facade,control,binding:{...binding,turnId:'other'}});
  await assert.rejects(other.status(ticket.operationId),/TASK_NOT_BOUND/);
  await assert.rejects(other.invoke('workspace_read_file',{path:'x'},ticket.ticket),/CALL_TICKET_SCOPE_DENIED/);
});
test('restart recovery queries only and cannot prepare or dispatch new work',async t=>{
  const {executor,facade,broker}=setup(t);
  assert.equal(await executor.recover('never-submitted'),null);
  const ticket=await executor.issue('before-crash','workspace_read_file',{path:'x'});
  const key=executor.key('before-crash'),record=facade.get('calls',key);record.operationId=null;facade.put('calls',key,record);
  const original=executor.control;
  executor.control=async(method,params)=>{assert.ok(!['prepare','dispatch'].includes(method));return original(method,params);};
  assert.deepEqual(await executor.recover('before-crash'),{operationId:ticket.operationId,requestHash:ticket.requestHash});
  assert.equal(broker.journal.all('ops').length,1);
  assert.equal(broker.get(ticket.operationId).starts,0);
  assert.equal((await executor.status(ticket.operationId)).structuredContent.task.state,'prepared');
});
test('MCP result delivery never acknowledges consumption; only trusted persisted receipts do',async t=>{
  const {executor,broker}=setup(t),ticket=await executor.issue('call','workspace_read_file',{path:'x'});
  const op=broker.get(ticket.operationId);broker.merge({...op,state:'succeeded',taskId:id(),result:{tool:{version:1,ok:true,response:{content:[{type:'text',text:'hello'}]}}},lastSeq:0,starts:1});
  const result=await executor.invoke('workspace_read_file',{path:'x'},ticket.ticket);assert.equal(result.content[0].text,'hello');
  assert.equal(broker.get(ticket.operationId).delivery,'pending');
  await assert.rejects(executor.issue('next','workspace_read_file',{path:'y'}),/WORKSPACE_RECOVERING/);
  const receipt={operationId:op.operationId,resultDigest:result.structuredContent.task.resultDigest,receiptId:'history-1'};
  await executor.consumeAfterPersist(receipt);await executor.consumeAfterPersist(receipt);assert.equal(broker.get(op.operationId).delivery,'consumed');
  await assert.rejects(executor.consumeAfterPersist({...receipt,receiptId:'different'}),/RECEIPT_CONFLICT/);
});
test('real MCP SDK rejects calls without host tickets and does not expose authorization tools',async t=>{
  const {executor}=setup(t),server=createWorkspaceMcp(executor),client=new Client({name:'mock-host',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(left);await client.connect(right);
  t.after(async()=>{await client.close();await server.close();});
  const tools=await client.listTools();assert.equal(tools.tools.length,13);assert.ok(!tools.tools.some(t=>/setMode|grant|consume|issue/.test(t.name)));
  const r=await client.callTool({name:'workspace_write_file',arguments:{path:'x',content:'x',mode:'append'}});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/CALL_TICKET_REQUIRED/);
  const bad=await client.callTool({name:'workspace_task_status',arguments:{operationId:'foreign'}});assert.equal(bad.isError,true);assert.match(bad.content[0].text,/TASK_NOT_BOUND/);
});
