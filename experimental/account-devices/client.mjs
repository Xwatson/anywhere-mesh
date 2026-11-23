import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import WebSocket from '../execution/node_modules/ws/wrapper.mjs';
import { Journal } from '../execution/journal.mjs';
import { LocalAgent } from '../execution/agent.mjs';
import { grantFor } from '../execution/grants.mjs';
import { Rpc } from '../execution/rpc.mjs';
import { CAPABILITIES } from '../execution/protocol.mjs';
import { makeLauncher, register } from '../desktop-commander/adapter.mjs';
import contract from './contract.cjs';
import { rememberedLogin } from './remembered-login.mjs';

register(); CAPABILITIES.push('workspace.grants.v1','history.archive.v1','review.v1');

export function request(url, tls, method, path, data, token, {idleMs=8000,totalMs=10000}={}) {
  const raw=data===undefined ? undefined : JSON.stringify(data);
  // An unconnected socket may never reach its inactivity timeout. Bound the whole request.
  const deadline=AbortSignal.timeout(totalMs);
  return new Promise((resolve,reject)=>{
    const req=https.request(new URL(path,url),{...tls,method,timeout:idleMs,signal:deadline,headers:{
      'User-Agent':'AnywhereCodingLab/1', ...(token ? {Authorization:'Bearer '+token} : {}), ...(raw ? {'Content-Type':'application/json'} : {})
    }},res=>{
      const chunks=[];let size=0;
      res.on('error',reject);res.on('data',part=>{size+=part.length;if(size>1024*1024)req.destroy(Error('RESPONSE_LIMIT'));else chunks.push(part);});
      res.on('end',()=>{try {const b=JSON.parse(Buffer.concat(chunks)); if(res.statusCode!==200)throw Error(b.error??'REMOTE_ERROR');resolve(b);} catch(e){reject(e);}});
    });
    req.on('error',error=>reject(deadline.aborted?Error('NETWORK_TIMEOUT'):error));
    req.on('timeout',()=>req.destroy(Error('NETWORK_TIMEOUT')));req.end(raw);
  });
}

function rootInfo(path) {
  const st=statSync(path,{bigint:true});
  if(realpathSync(path)!==path || !st.isDirectory()) throw Error('WORKSPACE_ROOT_CHANGED');
  return st.dev.toString()+':'+st.ino.toString();
}
function installation(cfg, identifyRoot) {
  mkdirSync(cfg.stateDir,{recursive:true,mode:0o700});
  const file=join(cfg.stateDir,'installation.json');
  let identity;
  try { identity=JSON.parse(readFileSync(file,'utf8')); }
  catch(e) {
    if(e.code!=='ENOENT') throw e;
    identity={secret:randomBytes(32).toString('hex'),projects:cfg.projects.map(p=>({
      path:p.path, inode:identifyRoot(p.path), localId:randomUUID()
    }))};
    writeFileSync(file,JSON.stringify(identity),{flag:'wx',mode:0o600});
  }
  if(cfg.workspacePicker) {
    const defaults=new Map(cfg.projects.map(p=>[p.path,p.label]));
    return {file,secret:identity.secret,projects:identity.projects.map(p=>({...p,label:p.label??defaults.get(p.path)}))};
  }
  const projects=cfg.projects.map(p=>{
    const known=identity.projects.find(k=>k.path===p.path);
    if(!known || known.inode!==identifyRoot(p.path)) throw Error('WORKSPACE_ROOT_CHANGED');
    return {...p,...known};
  });
  return {secret:identity.secret,projects};
}
export class DeviceClient {
  constructor(cfg, {identifyRoot=rootInfo, launcher=makeLauncher, modes, sandbox, loginProtection}={}) {
    this.cfg=cfg;this.identifyRoot=identifyRoot;this.launcher=launcher;this.modes=modes;this.sandbox=sandbox;
    this.profile=installation(cfg,identifyRoot);this.tls={ca:readFileSync(cfg.ca),rejectUnauthorized:true,minVersion:'TLSv1.3'};
    this.loginFile=rememberedLogin(cfg.stateDir,this.profile.secret,cfg.url,loginProtection);
    this.locals=new Map();this.queue=Promise.resolve();this.nextRestore=0;
  }
  api(method,path,data) { return request(this.cfg.url,this.tls,method,path,data,this.signed?.token); }
  ws(path) {
    return new WebSocket(new URL(path,this.cfg.url.replace(/^https:/,'wss:')),{
      ...this.tls,headers:{Authorization:'Bearer '+this.signed.token},handshakeTimeout:6000,maxPayload:65536,perMessageDeflate:false
    });
  }
  local(id) {
    const p=this.locals.get(id);
    if(!p) throw Error('ONLY_ON_BOUND_DEVICE');
    if(!p.available) throw Error('WORKSPACE_ROOT_CHANGED');
    return p;
  }
  setMode(p,mode) {
    if(this.modes && !this.modes.includes(mode)) throw Error('UNSUPPORTED_DEVICE_PERMISSION');
    if(p.agent.grant.mode!==mode) p.agent.control('setMode',{requestId:randomUUID(),expectedVersion:p.agent.grant.grantVersion,mode});
    return {mode:p.agent.grant.mode};
  }
  authenticate(input) { return this.api('POST','/api/auth/login',input); }
  attachProjects(signed, freshLogin) {
    for(const root of this.profile.projects) {
      const mapped=signed.projects.find(w=>w.localId===root.localId && w.deviceId===signed.deviceId);
      // A directory can be pinned locally before the server acknowledges registration.
      if(!mapped && this.cfg.workspacePicker) continue;
      if(!mapped) throw Error('WORKSPACE_BINDING_MISMATCH');
      this.attachProject(signed,root,mapped,freshLogin);
    }
  }
  attachProject(signed,root,mapped,freshLogin) {
    let available=false;
    try { available=this.identifyRoot(root.path)===root.inode; }
    catch(error) { if(!this.cfg.workspacePicker) throw error; }
    if(!available && !this.cfg.workspacePicker) throw Error('WORKSPACE_ROOT_CHANGED');
    const stateDir=join(this.cfg.stateDir,mapped.id);
    const store=new Journal(join(stateDir,'journal.sqlite'));
    try {
      const grant=grantFor({deviceId:signed.deviceId,accountId:String(signed.user.id),workspaceId:mapped.id},'revoked',1);
      const launch=this.launcher({workspaceRoot:root.path,rootIdentity:root.inode,stateDir,guardedFiles:true});
      const agent=new LocalAgent(store,grant,{stateDir,maxChildren:1,workspace:{label:root.label,reliability:true,sandbox:this.sandbox},
        launcher:(op,g)=>{if(this.identifyRoot(root.path)!==root.inode) throw Error('WORKSPACE_ROOT_CHANGED');return launch(op,g);}});
      const local={agent,store,id:mapped.id,path:root.path,available};
      if(freshLogin) this.setMode(local,'revoked');
      this.locals.set(mapped.id,local);
      agent.on('changed',()=>local.rpc?.notify('changed',{}));
      return local;
    } catch(error) {store.close();throw error;}
  }
  remembered() {
    if(this.saved===undefined) this.saved=this.loginFile.load();
    return this.saved;
  }
  async login(p) {
    if(this.signed || this.remembered()) throw Error('SIGN_OUT_FIRST');
    const signed=await this.authenticate({...p,installation:this.profile.secret,name:this.cfg.name,
      projects:this.profile.projects.map(({localId,label})=>({localId,label}))});
    this.signed=signed;
    try {
      this.attachProjects(signed,true);
      this.saved=this.loginFile.save(signed);
      this.connect(signed);
      return {user:signed.user,deviceId:signed.deviceId};
    } catch(error) {await this.signout();throw error;}
  }
  verifiedState(saved) {
    return request(this.cfg.url,this.tls,'GET','/api/state',undefined,saved.token);
  }
  currentState() { return this.api('GET','/api/state'); }
  async restore() {
    const signedOut={user:null,localName:this.cfg.name};
    const pending=()=>({...signedOut,restoring:true,connectionError:this.restoreIssue});
    if(Date.now()<this.nextRestore) return pending();
    try {
      const saved=this.remembered();
      if(!saved) return signedOut;
      const state=await this.verifiedState(saved);
      if(state.deviceId!==saved.deviceId || state.user.id!==saved.userId) throw Error('LOGIN_BINDING_MISMATCH');
      const signed={token:saved.token,deviceId:state.deviceId,user:state.user,projects:state.projects};
      this.attachProjects(signed,false);
      this.signed=signed;
      this.connect(signed);
      return this.localState(state);
    } catch(error) {
      if(['LOGIN_REQUIRED','DEVICE_DISABLED','LOGIN_BINDING_MISMATCH'].includes(error.message)) {
        await this.signout(false);
        return signedOut;
      }
      await this.disconnect(false);
      // A failed transport or an unavailable key store leaves the saved login intact.
      this.nextRestore=Date.now()+5000;
      this.restoreIssue=error.stage;
      return pending();
    }
  }
  connect(signed) {
    if(this.signed!==signed || this.presence) return;
    clearTimeout(this.retry);
    const ws=this.ws('/ws/device');this.presence=ws;ws.on('error',()=>{});
    let lastPing=Date.now();
    ws.on('ping',()=>{lastPing=Date.now();});
    const timer=setInterval(()=>{if(Date.now()-lastPing>11000)ws.terminate();},2000);
    ws.once('open',()=>{for(const p of this.locals.values())this.connectProject(signed,ws,p);});
    ws.once('close',()=>{
      clearInterval(timer);
      if(this.presence!==ws) return;
      this.presence=null;
      for(const p of this.locals.values()) {clearTimeout(p.retry);p.rpc?.close();}
      if(this.signed===signed) this.retry=setTimeout(()=>this.connect(signed),1000);
    });
    ws.once('unexpected-response',(_req,res)=>{
      res.resume();ws.terminate();
      if ((res.statusCode===401 || res.statusCode===403) && this.signed===signed) {
        // Only an expired login ends the local session. Other transport failures retry.
        this.api('GET','/api/state').catch(e=>{
          if(e.message==='LOGIN_REQUIRED' && this.signed===signed) this.expired(signed);
        });
      }
    });
  }
  connectProject(signed,presence,p) {
    if(!p.available || this.signed!==signed || this.presence!==presence || presence?.readyState!==WebSocket.OPEN) return;
    clearTimeout(p.retry);
    const ws=this.ws('/ws/projects/'+p.id);
    const rpc=new Rpc(ws,(m,params,frame)=>{
      if(this.signed!==signed || this.presence!==presence || p.rpc!==rpc) throw Error('STALE_CONNECTION');
      return p.agent.handle(m,params,frame.epoch);
    });
    p.rpc=rpc;
    ws.once('open',async()=>{
      try {
        const hello=await rpc.request('hello',{deviceId:signed.deviceId,instanceId:p.agent.instanceId,capabilities:CAPABILITIES});
        p.agent.attach(hello.connectionEpoch);rpc.epoch=hello.connectionEpoch;await rpc.request('ready',{});
      } catch { rpc.close(); }
    });
    rpc.once('closed',()=>{
      if(p.rpc!==rpc) return;
      p.rpc=null;
      if(this.signed===signed && this.presence===presence) p.retry=setTimeout(()=>this.connectProject(signed,presence,p),600);
    });
  }
  async disconnect(revoke) {
    this.signed=null;clearTimeout(this.retry);
    const presence=this.presence;this.presence=null;presence?.terminate();
    for(const p of this.locals.values()) {
      clearTimeout(p.retry);p.rpc?.close();
      if(revoke) this.setMode(p,'revoked');
      await p.agent.close();p.store.close();
    }
    this.locals.clear();
  }
  remoteLogout(signed) {
    return request(this.cfg.url,this.tls,'POST','/api/auth/logout',{},signed.token);
  }
  async signout(notify=true) {
    let signed=this.signed ?? this.saved;
    if(notify && signed===undefined) {
      try {signed=this.remembered();} catch {} // A locked vault can still be forgotten locally.
    }
    this.saved=null;this.nextRestore=0;this.restoreIssue=undefined;
    try {this.loginFile.clear();}
    finally {
      try {await this.disconnect(true);}
      finally {if(notify && signed) await this.remoteLogout(signed).catch(()=>{});}
    }
  }
  suspend() {
    return this.enqueue(()=>this.disconnect(false));
  }
  expired(signed) {
    this.queue=this.queue.catch(()=>{}).then(()=>this.signed===signed && this.signout(false));
    this.queue.catch(()=>{});
  }
  async act(method,p) {
    if(method==='login') return this.login(p);
    if(method==='logout') {await this.signout();return {ok:true};}
    if(!this.signed) {if(method==='state') return this.restore(); throw Error('LOGIN_REQUIRED');}
    if(method==='registerWorkspace' && this.cfg.workspacePicker) return this.registerWorkspace(p.path);
    if(method==='changePassword') return this.api('POST','/api/auth/password',p);
    if(method==='permission') return this.setMode(this.local(p.workspaceId),p.mode);
    if(method==='state') {
      try {return this.localState(await this.currentState());}
      catch(error) {
        if(!['LOGIN_REQUIRED','DEVICE_DISABLED','LOGIN_BINDING_MISMATCH'].includes(error.message)) throw error;
        await this.signout(false);
        return {user:null,localName:this.cfg.name};
      }
    }
    if(method==='admin') return this.api('GET','/api/admin/devices');
    if(method==='disable') return this.api('POST','/api/admin/devices/'+p.id,{disabled:p.disabled});
    if(method==='create') {this.local(p.workspaceId);return this.api('POST','/api/sessions',p);}
    const base='/api/sessions/'+p.sessionId;
    if(method==='history') return this.api('GET',base+'/events?afterSeq='+p.afterSeq);
    if(method==='send') return this.api('POST',base+'/messages',{requestId:p.requestId,text:p.text});
    if(method==='stop') return this.api('POST',base+'/stop',{requestId:p.requestId,turnId:p.turnId});
    throw Error('INVALID_FIELDS');
  }
  localState(state) {
    for(const project of state.projects) {
      const local=this.locals.get(project.id);
      if(!local) {
        if(this.cfg.workspacePicker && state.deviceId===project.deviceId) {project.localUnavailable=true;project.ready=false;}
        continue;
      }
      project.localMode=local.agent.grant.mode;
      if(this.modes) project.localModes=this.modes;
      if(this.cfg.workspacePicker) {
        project.localPath=local.path;
        if(!local.available) {project.localUnavailable=true;project.ready=false;}
      }
    }
    return {...state,localName:this.cfg.name,...(this.cfg.workspacePicker ? {workspacePicker:true} : {})};
  }
  enqueue(work) {
    const result=this.queue.catch(()=>{}).then(work);
    this.queue=result;
    return result;
  }
  control(method,p={}) {
    contract.internalValidate(method,p);
    return this.enqueue(()=>this.act(method,p));
  }
}
