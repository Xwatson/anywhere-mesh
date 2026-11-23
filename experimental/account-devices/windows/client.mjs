import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { win32 as path } from 'node:path';
import { DeviceClient, request } from '../client.mjs';
import contract from '../contract.cjs';
import { service } from './network.mjs';

const knownErrors = new Set(['INVALID_CREDENTIALS','LOGIN_THROTTLED','DEVICE_DISABLED','LOGIN_REQUIRED',
  'NETWORK_ENROLLMENT_UNAVAILABLE','NETWORK_ADDRESS_LIMIT','WINDOWS_NETWORK_EXITED','WINDOWS_TUNNEL_NOT_READY','EADDRINUSE']);
const publicRequest = (route,data,token) => request(service,{rejectUnauthorized:true,minVersion:'TLSv1.2'},
  'POST',route,data,token,{idleMs:15000,totalMs:18000});

async function phase(name, code, run, logSuccess=true) {
  const started=Date.now();
  const report=(result, error) => {
    const reason=error?.code ?? error?.message;
    console.error(JSON.stringify({component:'windows-device',phase:name,result,elapsedMs:Date.now()-started,
      ...(error ? {code:/^[A-Z][A-Z0-9_]{0,60}$/.test(reason) ? reason : code} : {})}));
  };
  try {
    const result=await run();
    if(logSuccess) report('ok');
    return result;
  } catch(error) {
    report('failed',error);
    const reason=error.code??error.message;
    const failure=Error(knownErrors.has(reason) ? reason : code, {cause:error});
    failure.stage=failure.message;
    throw failure;
  }
}

export class WindowsClient extends DeviceClient {
  constructor(cfg, workspace, {peer, privatePaths, bootstrap=publicRequest}) {
    super({...cfg,workspacePicker:true},workspace);
    this.peer=peer;this.privatePaths=privatePaths;this.bootstrap=bootstrap;
    this.httpFailures=0;this.probeFailures=0;
  }
  workspacePath(selected) {
    if(!/^[A-Za-z]:\\.+/.test(selected)) throw Error('LOCAL_PROJECT_REQUIRED');
    const root=path.normalize(selected).replace(/\\+$/,'');
    if(root.toLowerCase()===this.cfg.projects[0].path.toLowerCase()) return this.cfg.projects[0].path;
    const candidate=root.toLowerCase();
    for(const privatePath of this.privatePaths) {
      const reserved=privatePath.toLowerCase();
      if(candidate===reserved || candidate.startsWith(reserved+'\\') || reserved.startsWith(candidate+'\\')) throw Error('WORKSPACE_PATH_RESERVED');
    }
    return root;
  }
  async registerWorkspace(selected) {
    const folder=this.workspacePath(selected);
    let inode;
    try { inode=this.identifyRoot(folder); }
    catch { throw Error('LOCAL_PROJECT_REQUIRED'); }
    let root=this.profile.projects.find(p=>p.path.toLowerCase()===folder.toLowerCase());
    if(root && root.inode!==inode) throw Error('WORKSPACE_ROOT_CHANGED');
    if(!root) {
      if(this.profile.projects.length>=contract.workspaceLimit) throw Error('WORKSPACE_LIMIT');
      // Keep the same local ID if the response is lost after the server commits.
      root={path:folder,inode,localId:randomUUID(),label:path.basename(folder).trim().slice(0,80)||'本机项目'};
      const {file,secret}=this.profile, projects=[...this.profile.projects,root];
      const temp=file+'.'+randomUUID()+'.tmp';
      try {
        writeFileSync(temp,JSON.stringify({secret,projects}),{flag:'wx',mode:0o600,flush:true});
        renameSync(temp,file);
      } finally {rmSync(temp,{force:true});}
      this.profile.projects=projects;
    }
    const signed=this.signed;
    let mapped;
    try { mapped=await this.api('POST','/api/device/workspaces',{localId:root.localId,label:root.label}); }
    catch(error) { if(error.message==='NOT_FOUND') throw Error('WORKSPACE_REGISTRATION_UNAVAILABLE'); throw error; }
    if(mapped.localId!==root.localId || mapped.deviceId!==signed.deviceId) throw Error('WORKSPACE_BINDING_MISMATCH');
    contract.validate('permission',{workspaceId:mapped.id,mode:'revoked'});
    const existing=this.locals.get(mapped.id);
    const local=existing??this.attachProject(signed,root,mapped,true);
    if(existing) {
      try { local.available=this.identifyRoot(root.path)===root.inode; }
      catch { local.available=false; }
    }
    if(!local.available) {
      local.rpc?.close();
      throw Error('WORKSPACE_ROOT_CHANGED');
    }
    if(!local.rpc) this.connectProject(signed,this.presence,local);
    return this.localState({projects:[{...mapped,mode:local.agent.grant.mode,ready:false}]}).projects[0];
  }
  async authenticate(params) {
    // Keep an already-started legacy peer while it negotiates its first route.
    if(this.peer.legacy) {
      await this.ensureNetwork(undefined,40000);
      return phase('authentication','WINDOWS_AUTH_UNAVAILABLE',()=>super.authenticate(params));
    }
    // The device token is saved by login() before attempting network enrollment.
    return phase('authentication','WINDOWS_BOOTSTRAP_UNAVAILABLE',()=>this.bootstrap('/api/auth/login',params));
  }
  connect(signed) {
    if(this.peer.child && this.tunnelReady) super.connect(signed);
  }
  async ensureNetwork(signed,waitMs) {
    const peer=this.peer;
    if(!peer.legacy && (!peer.child || this.networkToken!==signed.token || this.probeFailures>=2)) {
      const profile=await phase('network_enrollment','WINDOWS_NETWORK_CONFIG_UNAVAILABLE',
        ()=>this.bootstrap('/api/device/network',{},signed.token));
      this.tunnelReady=false;
      await phase('peer_start','WINDOWS_TUNNEL_NOT_READY',()=>peer.start(profile,signed.deviceId,this.probeFailures>=2));
      this.cfg.url='https://127.0.0.1:'+peer.port;
      this.networkToken=signed.token;
      this.probeFailures=0;
    } else if(peer.legacy && !peer.child) {
      this.tunnelReady=false;
      await phase('peer_start','WINDOWS_TUNNEL_NOT_READY',()=>peer.start());
    }
    if(this.tunnelReady) return;
    try {
      await phase('tunnel_readiness','WINDOWS_TUNNEL_NOT_READY',()=>peer.ready(waitMs));
      this.tunnelReady=true;this.probeFailures=0;
    } catch(error) {this.probeFailures++;throw error;}
  }
  async verifiedState(saved) {
    if(Date.now()<this.retryNetworkAt) throw this.networkFailure;
    try {
      await this.ensureNetwork(saved);
      const state=await phase('state_sync','WINDOWS_STATE_UNAVAILABLE',async()=>{
        try {return await super.verifiedState(saved);}
        catch(error) {
          if(!['LOGIN_REQUIRED','DEVICE_DISABLED'].includes(error.message) && ++this.httpFailures>=2) this.tunnelReady=false;
          throw error;
        }
      }, !this.presence);
      this.httpFailures=0;
      return state;
    } catch(error) {
      this.retryNetworkAt=Date.now()+3000;this.networkFailure=error;
      throw error;
    }
  }
  async currentState() {
    const signed=this.signed;
    const state=await this.verifiedState(signed);
    if(state.user?.id!==signed.user.id || state.deviceId!==signed.deviceId) throw Error('LOGIN_BINDING_MISMATCH');
    this.connect(signed);
    return state;
  }
  async remoteLogout(signed) {
    if(this.peer.legacy) return super.remoteLogout(signed);
    if(this.peer.child && this.tunnelReady) {
      try {return await super.remoteLogout(signed);} catch {}
    }
    await this.bootstrap('/api/auth/logout',{},signed.token);
  }
  async signout(notify=true) {
    try {await super.signout(notify);}
    finally {
      this.retryNetworkAt=0;this.networkFailure=null;this.httpFailures=0;this.probeFailures=0;
      if(!this.peer.legacy) {
        this.networkToken=null;this.tunnelReady=false;
        await this.peer.stop();
      }
    }
  }
  async recover(signed) {
    if(!signed || this.signed!==signed || (this.peer.child && this.tunnelReady && !this.httpFailures && this.presence?.readyState===1)) return;
    try { await this.currentState(); }
    catch(error) {
      if(['LOGIN_REQUIRED','DEVICE_DISABLED','LOGIN_BINDING_MISMATCH'].includes(error.message)) await this.signout(false);
    }
  }
}
