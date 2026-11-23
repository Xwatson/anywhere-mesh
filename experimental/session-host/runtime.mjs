import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Client } from '../workspace/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../workspace/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { control } from '../execution/control.mjs';
import { WorkspaceExecutor } from '../workspace/executor.mjs';
import { hash } from '../execution/protocol.mjs';
import { SessionStore, uuid, fields, text } from './store.mjs';
import { parseMock } from './mock.mjs';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const sanitizeFileName = name => basename(String(name || 'file')).replace(/[\x00-\x1f/\\<>:"|?*]/g, '_').trim().slice(0, 120) || 'file';

export class SessionHost extends EventEmitter {
  constructor(config) {
    super(); this.config = config; this.store = new SessionStore(config.stateDir + '/history.sqlite');
    this.workspaces = new Map(config.workspaces.map(w => [w.id, w])); this.hosts = new Map(); this.busy = new Set(); this.work = new Set(); this.closing = false;
  }
  workspace(id) { uuid(id); const w = this.workspaces.get(id); if (!w) throw Error('WORKSPACE_NOT_ALLOWED'); return w; }
  broker(w, method, params = {}) { return control(w.brokerDir + '/control.sock', method, params); }
  session(id) {
    const s = this.store.session(id), w = this.workspace(s.workspaceId);
    if (this.config.accountId && this.config.requireDeviceBinding &&
        (s.accountId !== this.config.accountId || s.deviceId !== w.grant.deviceId)) throw Error('SESSION_TARGET_MISMATCH');
    return s;
  }
  sessions() { return this.store.all('sessions').map(s => ({ ...s, activeTurn: s.activeTurnId ? this.publicTurn(this.store.get('turns', s.activeTurnId)) : null })).sort((a,b) => b.updatedAt-a.updatedAt); }
  publicTurn(t) { if (!t) return null; return { id: t.id, sessionId: t.sessionId, workspaceId: t.workspaceId, operationId: t.operationId ?? null,
    state: t.state, done: Boolean(t.done), consumed: Boolean(t.consumed), cancelRequested: Boolean(t.cancelRequested), outcome: t.outcome ?? null }; }
  delta(sessionId, payload) { this.emit('delta', sessionId, payload); }
  async projectStates() {
    return Promise.all([...this.workspaces.values()].map(async w => {
      const info = await this.broker(w,'workspace'); return { id:w.id,label:w.label,deviceId:this.config.deviceId,
        phase:info.phase,confirmed:info.confirmed,permission:{mode:info.grant.mode,version:info.grant.grantVersion},blockers:info.blockers.length };
    }));
  }
  create(body) {
    fields(body,['requestId','workspaceId','title'],['options']);
    const w = this.workspace(body.workspaceId);
    const created = this.store.create(body, this.config.requireDeviceBinding ? w.grant : undefined);
    this.emit('state');
    return created;
  }
  renameSession(sessionId, title) {
    this.session(sessionId);
    const updated = this.store.rename(sessionId, title);
    this.emit('state');
    return updated;
  }
  updateSessionOptions(sessionId, options) {
    this.session(sessionId);
    const updated = this.store.updateOptions(sessionId, options);
    this.emit('state');
    return updated;
  }
  async deleteSession(sessionId) {
    this.session(sessionId);
    const removed = this.store.remove(sessionId);
    await rm(join(this.config.stateDir, 'attachments', sessionId), { recursive: true, force: true }).catch(() => {});
    this.emit('state');
    return { ok: true, id: removed.id };
  }
  async saveAttachment(sessionId, { name, mime, bytes }) {
    this.session(sessionId);
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw Error('INVALID_ATTACHMENT');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw Error('BODY_LIMIT');
    const safeName = sanitizeFileName(name);
    const safeMime = typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime.split(';')[0].trim()) ? mime.split(';')[0].trim().toLowerCase() : 'application/octet-stream';
    const id = randomUUID();
    const dir = join(this.config.stateDir, 'attachments', sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const storedName = `${id.slice(0, 8)}-${safeName}`;
    const fullPath = join(dir, storedName);
    await writeFile(fullPath, bytes, { flag: 'wx', mode: 0o600 });
    const meta = { id, name: safeName, mime: safeMime, size: bytes.length, storedName, createdAt: Date.now() };
    this.store.addAttachment(sessionId, meta);
    return { id, name: safeName, mime: safeMime, size: bytes.length };
  }
  attachmentPath(sessionId, attId) {
    const att = this.store.attachment(sessionId, attId);
    return { att, path: join(this.config.stateDir, 'attachments', sessionId, att.storedName) };
  }
  async readAttachmentBytes(sessionId, attId) {
    const { att, path } = this.attachmentPath(sessionId, attId);
    return { att, bytes: await readFile(path) };
  }
  async send(sessionId, body) {
    fields(body,['requestId','text'],['attachments']); uuid(body.requestId); text(body.text);
    const attIds = body.attachments ?? [];
    if (!Array.isArray(attIds) || attIds.length > 8) throw Error('INVALID_FIELDS');
    const resolvedAtts = attIds.map(id => {
      const { att, path } = this.attachmentPath(sessionId, id);
      return { id: att.id, name: att.name, mime: att.mime, size: att.size, path };
    });
    const s = this.session(sessionId);
    const payload = { kind:'send',sessionId,text:body.text,...(attIds.length ? { attachments: attIds } : {}) };
    const prior = this.store.request(body.requestId,payload);
    if (prior) return prior;
    if (s.activeTurnId) throw Error('SESSION_BUSY');
    const w = this.workspace(s.workspaceId);
    const diagnostic = /^\s*\/(?:read|list|search|append|build|long|run|help)(?:\s|$)/.test(body.text);
    const parsed = this.codex && !diagnostic ? { engine:'codex', text:body.text, attachments:resolvedAtts, calls:[] } :
      parseMock(body.text, path => this.store.get('revisions',hash({sessionId,workspaceId:w.id,path}))?.revision);
    let binding;
    if (!parsed.help) {
      const remote = await this.broker(w,'workspace');
      if (this.config.requireDeviceBinding && (remote.grant.accountId !== s.accountId ||
          remote.grant.deviceId !== s.deviceId || remote.grant.workspaceId !== s.workspaceId)) throw Error('SESSION_TARGET_MISMATCH');
      const concurrentReceipt = this.store.request(body.requestId,payload);
      if (concurrentReceipt) return concurrentReceipt;
      if (!remote.confirmed || remote.blockers.length || this.store.all('turns').some(t=>t.workspaceId===w.id&&!t.consumed&&!t.done)) throw Error('WORKSPACE_NOT_READY');
      const modes = parsed.tool==='workspace_run'?['execute']:parsed.tool==='workspace_write_file'?['edit','execute']:['read','edit','execute'];
      if (!modes.includes(remote.grant.mode)) throw Error('LOCAL_PERMISSION_REQUIRED');
      const supported=remote.sandbox?.supportedTools;
      if (parsed.tool && supported!==undefined && !(Array.isArray(supported)&&supported.includes(parsed.tool))) throw Error('TOOL_UNAVAILABLE_ON_DEVICE');
      binding = Object.fromEntries(['accountId','deviceId','workspaceId','grantVersion'].map(k=>[k,remote.grant[k]]));
    }
    this.store.ensureCapacity(1024*1024);
    if (this.store.all('turns').length >= 2000) throw Error('TURN_LIMIT');
    const publicAtts = resolvedAtts.map(({ id, name, mime, size }) => ({ id, name, mime, size }));
    const result = this.store.tx(()=>{
      const existing = this.store.request(body.requestId,payload); if(existing)return existing;
      if (this.session(s.id).activeTurnId || this.store.all('turns').some(t=>t.workspaceId===w.id&&!t.done)) throw Error('WORKSPACE_NOT_READY');
      const id = randomUUID(), turn = { id,sessionId:s.id,workspaceId:w.id,createdAt:Date.now(),state:'preparing',done:false,consumed:false,
        ...parsed,historyBefore:s.lastSeq,binding:binding?{...binding,sessionId:s.id,turnId:id,turnEpoch:1}:null };
      this.store.append(s.id,{type:'user_message',text:body.text,...(publicAtts.length?{attachments:publicAtts}:{})});
      if(parsed.help){
        turn.done=true;turn.consumed=true;turn.state='succeeded';
        this.store.append(s.id,{type:'assistant_text',id:randomUUID(),text:parsed.help});this.store.append(s.id,{type:'turn_end',ok:true});
      }else{
        if (parsed.tool) this.store.append(s.id,{type:'tool_call',id,name:parsed.tool,input:parsed.args,status:'running'});
        const current=this.session(s.id);current.activeTurnId=id;this.store.put('sessions',s.id,current);
      }
      this.store.put('turns',id,turn);const reply={sessionId:s.id,workspaceId:w.id,historyEpoch:s.historyEpoch,turnId:id,acceptedSeq:this.session(s.id).lastSeq};this.store.receipt(body.requestId,payload,reply);return reply;
    });
    this.emit('events',s.id);
    const turn=this.store.get('turns',result.turnId);
    if(!turn.done)this.track(turn.engine==='codex' ? this.codex.run(turn) : this.dispatch(turn));return result;
  }
  track(p) { this.work.add(p);p.catch(e=>console.error('host background:',e.message)).finally(()=>this.work.delete(p));return p; }
  async host(t) {
    if(this.hosts.has(t.id))return this.hosts.get(t.id);
    const w=this.workspace(t.workspaceId),path=`${this.config.stateDir}/call-${t.id}.json`;
    await writeFile(path,JSON.stringify({binding:t.binding,journalPath:this.store.path,brokerSocket:w.brokerDir+'/control.sock',waitMs:0}),{mode:0o600});
    const client=new Client({name:'anywhere-session-'+(t.engine??'mock'),version:'0.2.0'}),transport=new StdioClientTransport({command:process.execPath,args:[this.config.mcpPath,path],stderr:'pipe',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}});
    const connecting=client.connect(transport);transport.stderr?.resume();try{await connecting;}catch(e){await client.close().catch(()=>{});throw e;}
    const h={client,path,executor:new WorkspaceExecutor({journal:this.store,binding:t.binding,control:(m,p)=>this.broker(w,m,p)})};this.hosts.set(t.id,h);return h;
  }
  async closeHost(id){const h=this.hosts.get(id);if(!h)return;this.hosts.delete(id);await h.client.close().catch(()=>{});await unlink(h.path).catch(()=>{});}
  async dispatch(turn){
    if(this.busy.has(turn.id))return;this.busy.add(turn.id);
    try{
      const h=await this.host(turn),ticket=await h.executor.issue(turn.id,turn.tool,turn.args);
      turn={...this.store.get('turns',turn.id),operationId:ticket.operationId};this.store.put('turns',turn.id,turn);
      const r=await h.client.callTool({name:turn.tool,arguments:turn.args,_meta:{'anywhere/callTicket':ticket.ticket}},undefined,{timeout:15000});
      await this.capture(this.store.get('turns',turn.id),h,r);
    }catch(e){const t=this.store.get('turns',turn.id);t.error=e.message;this.store.put('turns',t.id,t);}
    finally{this.busy.delete(turn.id);}
  }
  start(){this.timer=setInterval(()=>{for(const t of this.store.all('turns'))if(!t.consumed)this.track(this.refresh(t.id));},600);}
  async refresh(id){
    if(this.closing||this.busy.has(id))return;this.busy.add(id);
    try{
      let t=this.store.get('turns',id);if(t.consumed)return;
      if (t.engine==='codex') {
        if (this.codex && !this.codex.active.has(id)) await this.codex.reconcile(t);
        return;
      }
      const h=await this.host(t);
      if(!t.operationId){
        const found=await h.executor.recover(t.id);
        if(!found){this.finishUnsubmitted(t);await this.closeHost(id);return;}
        t={...this.store.get('turns',id),operationId:found.operationId};this.store.put('turns',id,t);
      }
      if(t.cancelRequested)await this.broker(this.workspace(t.workspaceId),'stopTurn',{sessionId:t.sessionId,turnId:t.id,turnEpoch:1});
      await this.capture(t,h,await h.client.callTool({name:'workspace_task_status',arguments:{operationId:t.operationId}}));
    }catch(e){const t=this.store.get('turns',id);t.error=e.message;this.store.put('turns',id,t);}
    finally{this.busy.delete(id);}
  }
  finishUnsubmitted(t){
    this.store.tx(()=>{t={...t,...this.store.get('turns',t.id)};t.state=t.cancelRequested?'cancelled':'interrupted';t.done=true;t.consumed=true;this.store.put('turns',t.id,t);
      this.store.append(t.sessionId,{type:'tool_call',id:t.id,name:t.tool,input:t.args,status:'failed',output:'提交前中断，未发现已准备操作；没有自动重试。'});
      this.store.append(t.sessionId,{type:'turn_end',ok:false,error:'提交前中断'});
      const s=this.session(t.sessionId);if(s.activeTurnId===t.id){s.activeTurnId=null;this.store.put('sessions',s.id,s);}});this.emit('events',t.sessionId);
  }
  async capture(t,h,r){
    const data=r.structuredContent,task=data?.task;if(!task)throw Error(data?.error??'INVALID_TOOL_RESULT');
    const latest=this.store.get('turns',t.id);t.cancelRequested=latest.cancelRequested||task.cancelRequested;
    t.state=task.state;t.error=null;t.outcome=data.result?.executionOutcome;
    const pages=[];let cursor=0;
    while(cursor<task.receivedSeq){const p=await h.executor.output(t.operationId,cursor);if(p.nextSeq<=cursor)throw Error('OUTPUT_NO_PROGRESS');pages.push(p);cursor=p.nextSeq;}
    const output=pages.flatMap(p=>p.rows).map(p=>p.data).join('');
    const text=r.content?.filter(p=>p.type==='text').map(p=>p.text).join('\n')??'';
    const truncated=output.length>12000||pages.some(p=>p.truncatedThrough>0);
    let display=(output||text).slice(-12000);if(truncated)display='[仅显示保留输出的末尾；较早内容已截断]\n'+display;
    if(task.state==='unknown')display+='\n结果未知：请撤销本地权限并核对，任务不会自动重跑。';
    if(task.state==='reviewed')display+='\n本地已核对，执行结果仍为未知。';
    while(Buffer.byteLength(JSON.stringify(display))>8500)display='[输出节选]\n'+display.slice(Math.ceil(display.length/4));
    const event={type:'tool_call',id:t.id,name:t.tool,input:t.args,status:task.resultReady?(task.state==='succeeded'?'completed':'failed'):task.state==='unknown'?'failed':'running',output:display};
    const viewHash=hash({event,state:task.state});
    this.store.tx(()=>{
      t.cancelRequested ||= this.store.get('turns',t.id)?.cancelRequested;
      if(t.viewHash!==viewHash){this.store.append(t.sessionId,event);t.viewHash=viewHash;}
      if(task.resultReady&&!t.receipt){
        t.receipt={receiptId:'session-history:'+t.id,resultDigest:task.resultDigest};
        this.store.put('results',t.id,{...t.receipt,response:r,pages});
        for(const f of data.result?.fileVersions??[]){const path=f.path??t.args.path;this.store.put('revisions',hash({sessionId:t.sessionId,workspaceId:t.workspaceId,path}),f);}
        this.store.append(t.sessionId,{type:'assistant_text',id:randomUUID(),text:task.state==='succeeded'?'模拟宿主已收到并保存国内工作区的执行结果。':task.state==='reviewed'?'已记录本地核对结论，结果仍为未知，没有重新执行。':task.state==='cancelled'?'国内设备已确认任务停止。':`任务结束：${task.state}。请查看工具输出。`});
        this.store.append(t.sessionId,{type:'turn_end',ok:task.state==='succeeded',...(task.state==='succeeded'?{}:{error:task.state==='reviewed'?'已核对，结果未知':task.state==='cancelled'?'已取消':'执行失败'})});
      }
      this.store.put('turns',t.id,t);
    });
    this.emit('events',t.sessionId);
    if(task.resultReady){
      await h.executor.consumeAfterPersist({operationId:t.operationId,...t.receipt});
      this.store.tx(()=>{t.done=true;t.consumed=true;this.store.put('turns',t.id,t);const s=this.session(t.sessionId);if(s.activeTurnId===t.id){s.activeTurnId=null;this.store.put('sessions',s.id,s);}});
      await this.closeHost(t.id);this.emit('events',t.sessionId);
    }
  }
  async stop(sessionId,body){
    fields(body,['requestId','turnId']);uuid(body.requestId);uuid(body.turnId);
    this.session(sessionId);const payload={kind:'stop',sessionId,turnId:body.turnId},prior=this.store.request(body.requestId,payload);if(prior)return prior;
    const t=this.store.get('turns',body.turnId);if(!t||t.sessionId!==sessionId)throw Error('TURN_NOT_BOUND');
    const result={requested:true,turnId:t.id};
    this.store.tx(()=>{if(!t.done)t.cancelRequested=true;this.store.put('turns',t.id,t);this.store.receipt(body.requestId,payload,result);});
    if(!t.done) {
      if (t.engine==='codex') await this.codex?.interrupt(t.id);
      else await this.broker(this.workspace(t.workspaceId),'stopTurn',{sessionId,turnId:t.id,turnEpoch:1});
    }
    return result;
  }
  async close(){this.closing=true;clearInterval(this.timer);await this.codex?.close();await Promise.allSettled([...this.work]);for(const id of [...this.hosts.keys()])await this.closeHost(id);this.store.close();}
}
