import {readFileSync,realpathSync,lstatSync,existsSync} from 'node:fs';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {DesktopCache} from './cache.mjs';
import {Remote} from './remote.mjs';
import {control,serveControl} from '../execution/control.mjs';
import contract from './contract.cjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const knownRejections=new Set(['LOCAL_PERMISSION_REQUIRED','WORKSPACE_NOT_READY','SESSION_BUSY','REQUEST_CONFLICT','READ_FILE_BEFORE_EDIT','INVALID_FIELDS','INVALID_TEXT','BODY_LIMIT','TURN_LIMIT','HISTORY_STORAGE_FULL','INVALID_PATH','PATH_ESCAPE','PATH_DENIED']);
export class DesktopBridge {
  constructor(cfg){this.cfg=cfg;this.cache=new DesktopCache(cfg.stateDir+'/cache.sqlite');this.remote=new Remote(cfg);this.enabled=false;this.online=false;this.error=null;this.queue=Promise.resolve();this.generation=0;}
  workspace(id){const w=this.cfg.workspaces.find(w=>w.id===id);if(!w)throw Error('WORKSPACE_NOT_ALLOWED');return w;}
  registered(id){const w=this.workspace(id);if(!(this.cache.get('local','registered')??[]).includes(id))throw Error('WORKSPACE_NOT_REGISTERED');return w;}
  session(id){const s=this.cache.get('sessions',id);if(!s)throw Error('SESSION_NOT_CACHED');this.registered(s.workspaceId);return s;}
  local(w,m,p={}){return control(w.localSocket,m,p);}
  async revokeAll(){for(const w of this.cfg.workspaces)await this.permission(w.id,'revoked',true);}
  async permission(id,mode,internal=false){const w=internal?this.workspace(id):this.registered(id),s=await this.local(w,'status');
    if(s.grant.mode!==mode)await this.local(w,'setMode',{requestId:randomUUID(),expectedVersion:s.grant.grantVersion,mode});
  }
  async init(){
    for(const w of this.cfg.workspaces){const end=Date.now()+7000;while(true){try{await this.permission(w.id,'revoked',true);break;}catch(e){if(Date.now()>end)throw e;await sleep(150);}}}
    this.timer=setInterval(()=>{if(this.enabled)this.sync().catch(e=>{this.error=e.message;});},1000);
  }
  control(method,params={}){
    if(['enable','disable','revokeAll'].includes(method)){
      if(Object.keys(params).length)throw Error('INVALID_FIELDS');
      if(method==='enable'){this.enabled=true;this.connectStream();return Promise.resolve({enabled:true});}
      if(method==='disable'){this.enabled=false;this.online=false;this.generation++;this.ws?.terminate();clearTimeout(this.retry);return Promise.resolve({enabled:false});}
      return this.revokeAll().then(()=>({revoked:true}));
    }
    contract.internalValidate(method,params);
    if(method==='state')return this.state();
    if(method==='history'){this.session(params.sessionId);return Promise.resolve(this.cache.page(params.sessionId,params.beforeSeq));}
    const task=this.queue.catch(()=>{}).then(()=>this.mutate(method,params));this.queue=task;return task;
  }
  async mutate(method,p){
    if(method==='registerWorkspace'){
      const real=realpathSync(p.path),w=this.cfg.workspaces.find(w=>w.path===real),st=lstatSync(p.path);
      if(!w||real!==p.path||st.isSymbolicLink()||!st.isDirectory()||String(st.dev)!==String(w.dev)||String(st.ino)!==String(w.ino))throw Error('WORKSPACE_NOT_PROVISIONED');
      this.cache.tx(()=>{const ids=this.cache.get('local','registered')??[];if(!ids.includes(w.id)){ids.push(w.id);this.cache.put('local','registered',ids);}this.cache.put('local','selection',{workspaceId:w.id,sessionId:null});});return this.state();
    }
    if(method==='selectWorkspace'){this.registered(p.workspaceId);this.cache.put('local','selection',{workspaceId:p.workspaceId,sessionId:null});return this.state();}
    if(method==='selectSession'){const s=this.session(p.sessionId);this.cache.put('local','selection',{workspaceId:s.workspaceId,sessionId:s.id});this.subscribe(s);return this.state();}
    if(method==='permission'){await this.permission(p.workspaceId,p.mode);return this.state();}
    if(method==='createSession'){
      this.registered(p.workspaceId);if(!this.online)throw Error('REMOTE_OFFLINE');
      const result=await this.submit({kind:'create',method:'POST',path:'/api/sessions',body:{requestId:randomUUID(),workspaceId:p.workspaceId,title:p.title},workspaceId:p.workspaceId});
      this.cache.put('local','selection',{workspaceId:p.workspaceId,sessionId:result.id});return result;
    }
    if(method==='send'||method==='stop'){
      const s=this.session(p.sessionId);if(!this.online)throw Error('REMOTE_OFFLINE');
      const body=method==='send'?{requestId:randomUUID(),text:p.text}:{requestId:randomUUID(),turnId:p.turnId};
      return this.submit({kind:method,method:'POST',path:`/api/sessions/${s.id}/${method==='send'?'messages':'stop'}`,body,workspaceId:s.workspaceId,sessionId:s.id});
    }
    if(method==='retry'){
      const saved=this.cache.get('outbox',p.requestId);if(!saved||saved.status!=='pending')throw Error('NOT_PENDING');this.registered(saved.workspaceId);
      if(!this.online)throw Error('REMOTE_OFFLINE');return this.submit(saved);
    }
    if(method==='reviewPreview'||method==='review'){
      const s=this.session(p.sessionId),w=this.registered(s.workspaceId);
      let turn=s.activeTurn;
      if(this.online)turn=await this.remote.request('GET',`/api/sessions/${s.id}/turns/${p.turnId}`);
      if(!turn||turn.id!==p.turnId||turn.sessionId!==s.id||turn.workspaceId!==w.id||!turn.operationId)throw Error('TURN_NOT_BOUND');
      if(method==='reviewPreview'){
        const v=await this.local(w,'reviewPreview',{operationId:turn.operationId});
        if(v.request.scope.workspaceId!==w.id||v.request.scope.sessionId!==s.id||v.request.scope.turnId!==turn.id)throw Error('REVIEW_BINDING_MISMATCH');
        return {sessionId:s.id,turnId:turn.id,digest:v.expectedDigest,reason:v.reason,starts:v.starts,request:v.request.args};
      }
      const key=turn.id,prior=this.cache.get('reviews',key),decision={requestId:prior?.requestId??randomUUID(),operationId:turn.operationId,expectedDigest:p.digest,disposition:'acknowledge_unknown',note:p.note.trim()};
      if(prior&&(prior.expectedDigest!==p.digest||prior.note!==decision.note))throw Error('REVIEW_CONFLICT');
      this.cache.put('reviews',key,decision);return this.local(w,'reviewUnknown',decision);
    }
    throw Error('INVALID_DESKTOP_REQUEST');
  }
  async submit(request){
    const id=request.body.requestId;this.cache.ensureCapacity(512*1024);this.cache.put('outbox',id,{...request,status:'pending'});
    try{const result=await this.remote.request(request.method,request.path,request.body);this.acceptReceipt(request,result);await this.sync();return result;}
    catch(e){if(knownRejections.has(e.message))this.cache.put('outbox',id,{...request,status:'rejected',error:e.message});throw e;}
  }
  acceptReceipt(request,result){
    if(request.kind==='create'){
      if(!result?.id||result.workspaceId!==request.workspaceId)throw Error('RECEIPT_BINDING_MISMATCH');
      this.cache.put('sessions',result.id,result);this.subscribe(result);
    }else if(request.kind==='send'){
      const s=this.session(request.sessionId);
      if(result?.sessionId!==s.id||result.workspaceId!==s.workspaceId||result.historyEpoch!==s.historyEpoch||!Number.isSafeInteger(result.acceptedSeq))throw Error('RECEIPT_BINDING_MISMATCH');
      if(s.lastSeq<result.acceptedSeq)this.cache.put('sessions',s.id,{...s,lastSeq:result.acceptedSeq,activeTurnId:result.turnId,
        activeTurn:{id:result.turnId,sessionId:s.id,workspaceId:s.workspaceId,state:'accepted',done:false,consumed:false,cancelRequested:false}});
    }
    else if(request.kind==='stop'&&result?.turnId!==request.body.turnId)throw Error('RECEIPT_BINDING_MISMATCH');
    this.cache.put('outbox',request.body.requestId,{...request,status:'accepted',result});
  }
  async sync(){
    if(!this.enabled)return;if(this.syncing)return this.syncing;
    this.syncing=(async()=>{
      const [meta,sessions]=await Promise.all([this.remote.request('GET','/api/workspaces'),this.remote.request('GET','/api/sessions')]);
      if(meta.deviceId!==this.cfg.deviceId||meta.accountId!==this.cfg.accountId||!Array.isArray(sessions)||sessions.length>50)throw Error('REMOTE_IDENTITY_MISMATCH');
      for(const s of sessions){
        this.workspace(s.workspaceId);const old=this.cache.get('sessions',s.id);
        if(old&&(old.workspaceId!==s.workspaceId||old.historyEpoch!==s.historyEpoch))throw Error('HISTORY_BINDING_MISMATCH');
        if(old&&s.lastSeq<Math.max(old.lastSeq,this.cache.get('cursors',s.id)?.seq??0))continue;
        this.cache.put('sessions',s.id,s);this.subscribe(s);
      }
      this.cache.put('remote','meta',meta);this.error=null;
      for(const pending of this.cache.all('outbox').filter(r=>r.status==='pending')){
        const result=await this.remote.request('GET','/api/requests/'+pending.body.requestId);
        if(result)this.acceptReceipt(pending,result); // Recovery never replays POST.
      }
    })();try{return await this.syncing;}finally{this.syncing=null;}
  }
  subscribe(s){
    if(this.ws?.readyState!==1||!(this.cache.get('local','registered')??[]).includes(s.workspaceId))return;
    this.ws.send(JSON.stringify({t:'sub',sessionId:s.id,historyEpoch:s.historyEpoch,afterSeq:this.cache.get('cursors',s.id)?.seq??0}));
  }
  connectStream(){
    if(!this.enabled||this.ws&&[0,1].includes(this.ws.readyState))return;
    const gen=++this.generation,ws=this.remote.stream();this.ws=ws;
    let lastPing=Date.now();const heartbeat=setInterval(()=>{if(ws.readyState===1&&Date.now()-lastPing>9000)ws.terminate();},1500);
    ws.on('ping',()=>{lastPing=Date.now();});
    ws.on('open',()=>{if(gen!==this.generation)return;this.online=true;this.sync().catch(e=>{this.error=e.message;ws.close();});});
    ws.on('message',raw=>{
      if(gen!==this.generation)return;
      try{const page=JSON.parse(raw);if(page.t!=='events')throw Error('INVALID_STREAM');this.cache.ensureCapacity();this.cache.merge(page);this.subscribe(this.cache.get('sessions',page.sessionId));}
      catch(e){this.error=e.message;ws.close();}
    });
    ws.on('error',e=>{if(gen===this.generation)this.error=e.message;});
    ws.on('close',()=>{clearInterval(heartbeat);if(gen!==this.generation)return;this.online=false;this.ws=null;if(this.enabled)this.retry=setTimeout(()=>this.connectStream(),800);});
  }
  async state(){
    const ids=this.cache.get('local','registered')??[],meta=this.cache.get('remote','meta'),selection=this.cache.get('local','selection')??{workspaceId:null,sessionId:null};
    const projects=await Promise.all(ids.map(async id=>{const w=this.workspace(id);let l;try{l=await this.local(w,'status');}catch{}
      const r=meta?.workspaces.find(p=>p.id===id);
      return {id,label:w.label,path:w.path,permission:{mode:l?.grant.mode??'revoked',localReady:Boolean(l),synced:Boolean(this.online&&l&&r?.confirmed&&r.permission.version===l.grant.grantVersion)},blockers:r?.blockers??0,unknown:l?.unknownOperations.length??0};
    }));
    return {version:2,mockHost:true,connection:this.online?'connected':this.enabled?'connecting':'disconnected',projects,selection,
      sessions:this.cache.all('sessions').filter(s=>ids.includes(s.workspaceId)).sort((a,b)=>b.updatedAt-a.updatedAt),
      pending:this.cache.all('outbox').filter(r=>r.status==='pending').map(r=>({requestId:r.body.requestId,sessionId:r.sessionId,workspaceId:r.workspaceId,kind:r.kind})),error:this.error};
  }
  async close(){this.enabled=false;this.generation++;clearInterval(this.timer);clearTimeout(this.retry);this.ws?.terminate();await this.queue.catch(()=>{});await this.syncing?.catch(()=>{});this.cache.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(hostname()!=='anywhere-crossborder-lab'||!existsSync('/etc/anywhere-crossborder-lab'))throw Error('LAB_GUEST_REQUIRED');
  const cfg=JSON.parse(readFileSync(process.argv[2],'utf8')),bridge=new DesktopBridge(cfg);await bridge.init();
  const rpc={control:async(method,params)=>{try{return await bridge.control(method,params);}catch(e){
    if(!e.code&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message))e.code=e.message;throw e;
  }}};
  const server=await serveControl(cfg.controlSocket,rpc);let closing=false;
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{if(closing)return;closing=true;server.close();await bridge.close();process.exit(0);});
}
