import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionStore} from '../../session-host/store.mjs';
import {SessionHost} from '../../session-host/runtime.mjs';
import {DesktopCache} from '../cache.mjs';
import {DesktopBridge} from '../bridge.mjs';
import contract from '../contract.cjs';
import {parseMock} from '../../session-host/mock.mjs';
const fixture=t=>{const dir=mkdtempSync(join(tmpdir(),'desktop-session-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
test('session create receipt binds workspace and title; same path text cannot change an immutable ID',t=>{
 const db=new SessionStore(join(fixture(t),'h.sqlite'));t.after(()=>db.close());const body={requestId:randomUUID(),workspaceId:randomUUID(),title:'A'};
 const a=db.create(body);assert.deepEqual(db.create(body),a);assert.throws(()=>db.create({...body,workspaceId:randomUUID()}),/REQUEST_CONFLICT/);assert.equal(db.all('sessions').length,1);
});
test('event page has ordered durable cursors and refuses a future cursor',t=>{
 const db=new SessionStore(join(fixture(t),'h.sqlite'));t.after(()=>db.close());const s=db.create({requestId:randomUUID(),workspaceId:randomUUID(),title:'A'});
 db.tx(()=>{db.append(s.id,{type:'user_message',text:'hi'});db.append(s.id,{type:'notice',level:'info',text:'pending'});});
 assert.deepEqual(db.page(s.id,0).events.map(r=>r.seq),[1,2]);assert.equal(db.page(s.id,1).throughSeq,2);assert.throws(()=>db.page(s.id,3),/INVALID_CURSOR/);
});
test('stream cache deduplicates replay but refuses wrong epoch, target, gaps and changed historical content atomically',t=>{
 const db=new DesktopCache(join(fixture(t),'c.sqlite'));t.after(()=>db.close());const s={id:randomUUID(),workspaceId:randomUUID(),historyEpoch:randomUUID()};db.put('sessions',s.id,s);
 const page={sessionId:s.id,workspaceId:s.workspaceId,historyEpoch:s.historyEpoch,events:[{seq:1,ts:1,event:{type:'user_message',text:'A'}}],throughSeq:1};
 assert.equal(db.merge(page),1);assert.equal(db.merge(page),1);
 for(const patch of [{workspaceId:randomUUID()},{historyEpoch:randomUUID()},{events:[{seq:3,ts:3,event:{type:'notice'}}],throughSeq:3},{events:[{seq:1,ts:1,event:{type:'user_message',text:'B'}}]}])assert.throws(()=>db.merge({...page,...patch}),/HISTORY_/);
 assert.equal(db.page(s.id).events.length,1);assert.equal(db.get('cursors',s.id).seq,1);
});
test('public renderer bridge cannot supply a native selected path or privileged method',()=>{
 assert.throws(()=>contract.publicValidate('registerWorkspace',{path:'/etc'}));assert.throws(()=>contract.publicValidate('chooseWorkspace',{path:'/etc'}));assert.throws(()=>contract.publicValidate('revokeAll',{}));
 assert.throws(()=>contract.publicValidate('send',{sessionId:randomUUID(),text:'x',workspaceId:randomUUID()}));assert.doesNotThrow(()=>contract.internalValidate('registerWorkspace',{path:'/fixed/project'}));
});
test('accepted send cannot be rolled back by late metadata or resurrected by a repeated receipt',async t=>{
 const cache=new DesktopCache(join(fixture(t),'c.sqlite'));t.after(()=>cache.close());
 const s={id:randomUUID(),workspaceId:randomUUID(),historyEpoch:randomUUID(),lastSeq:2,activeTurn:null},turnId=randomUUID();
 cache.put('sessions',s.id,s);cache.put('local','registered',[s.workspaceId]);
 let snapshot={...s};const cfg={deviceId:'device',accountId:'account',workspaces:[{id:s.workspaceId}]};
 const bridge=Object.assign(Object.create(DesktopBridge.prototype),{cfg,cache,enabled:true,subscribe:()=>{},remote:{request:async(_m,path)=>path==='/api/workspaces'?{deviceId:'device',accountId:'account'}:[snapshot]}});
 const request={kind:'send',sessionId:s.id,body:{requestId:randomUUID()}},receipt={sessionId:s.id,workspaceId:s.workspaceId,historyEpoch:s.historyEpoch,turnId,acceptedSeq:4};
 assert.throws(()=>bridge.acceptReceipt(request,{...receipt,workspaceId:randomUUID()}),/RECEIPT_BINDING_MISMATCH/);
 bridge.acceptReceipt(request,receipt);await bridge.sync();assert.equal(cache.get('sessions',s.id).activeTurn.id,turnId);
 snapshot={...s,lastSeq:5};await bridge.sync();bridge.acceptReceipt(request,receipt);assert.equal(cache.get('sessions',s.id).activeTurn,null);
});
test('mock does not silently interpret natural language as a command, and edits need a session-scoped snapshot',()=>{
 assert.ok(parseMock('please delete files',()=>null).help);assert.throws(()=>parseMock('/append notes.txt hello',()=>null),/READ_FILE_BEFORE_EDIT/);
 assert.throws(()=>parseMock('/read ../../etc/passwd',()=>null));assert.equal(parseMock('/read notes.txt',()=>null).tool,'workspace_read_file');
});
test('mock help history is durable and idempotent, unknown workspace and forged send scope are refused',async t=>{
 const workspaceId=randomUUID(),host=new SessionHost({stateDir:fixture(t),workspaces:[{id:workspaceId,label:'A'}]});t.after(()=>host.close());
 assert.throws(()=>host.create({requestId:randomUUID(),workspaceId:randomUUID(),title:'bad'}),/WORKSPACE_NOT_ALLOWED/);
 const session=host.create({requestId:randomUUID(),workspaceId,title:'hello'}),body={requestId:randomUUID(),text:'hi'};
 const first=await host.send(session.id,body);assert.deepEqual(await host.send(session.id,body),first);
 assert.equal(host.store.page(session.id).events.length,3);
 await assert.rejects(host.send(session.id,{...body,workspaceId:randomUUID()}),/INVALID_FIELDS/);
 const other=host.create({requestId:randomUUID(),workspaceId,title:'other'});
 await assert.rejects(host.stop(other.id,{requestId:randomUUID(),turnId:first.turnId}),/TURN_NOT_BOUND/);
});
test('turn result and chat history commit before consumption; lost ack does not duplicate the turn ending',async t=>{
 const wid=randomUUID(),host=new SessionHost({stateDir:fixture(t),workspaces:[{id:wid,label:'A'}]});t.after(()=>host.close());
 const s=host.create({requestId:randomUUID(),workspaceId:wid,title:'A'}),turn={id:randomUUID(),sessionId:s.id,workspaceId:wid,tool:'workspace_run',args:{command:'echo x'},operationId:randomUUID()};
 host.store.put('turns',turn.id,turn);s.activeTurnId=turn.id;host.store.put('sessions',s.id,s);
 const response={content:[{type:'text',text:'finished'}],structuredContent:{task:{state:'succeeded',resultReady:true,resultDigest:'digest',lastSeq:0,receivedSeq:0},result:{ok:true}}};
 let attempts=0;const h={executor:{consumeAfterPersist:async()=>{assert.ok(host.store.get('results',turn.id));assert.equal(host.store.page(s.id).events.at(-1).event.type,'turn_end');if(++attempts===1)throw Error('ACK_LOST');}}};
 await assert.rejects(host.capture(turn,h,response),/ACK_LOST/);const count=host.store.page(s.id).events.length;
 await host.capture(host.store.get('turns',turn.id),h,response);assert.equal(host.store.page(s.id).events.length,count);assert.equal(host.session(s.id).activeTurnId,null);
});
test('a durable stop arriving while output is read survives the subsequent result snapshot',async t=>{
 const wid=randomUUID(),host=new SessionHost({stateDir:fixture(t),workspaces:[{id:wid,label:'A'}]});t.after(()=>host.close());
 const s=host.create({requestId:randomUUID(),workspaceId:wid,title:'A'}),turn={id:randomUUID(),sessionId:s.id,workspaceId:wid,tool:'workspace_run',args:{command:'echo x'},operationId:randomUUID(),cancelRequested:false};host.store.put('turns',turn.id,turn);
 const h={executor:{output:async()=>{host.store.put('turns',turn.id,{...turn,cancelRequested:true});return{nextSeq:1,rows:[{data:'x'}],truncatedThrough:0};}}};
 await host.capture(turn,h,{content:[],structuredContent:{task:{state:'running',resultReady:false,lastSeq:1,receivedSeq:1},result:null}});
 assert.equal(host.store.get('turns',turn.id).cancelRequested,true);
});
