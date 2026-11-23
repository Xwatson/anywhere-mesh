import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeviceClient } from '../client.mjs';
import contract from '../contract.cjs';
import { WindowsClient } from './client.mjs';

const defaultPath=String.raw`C:\AnywhereCodingLab\project`;
const addedPath=String.raw`C:\开发\第二个项目`;
const credentials={username:'member',password:'initial password'};

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'windows-client-'));
  const clients=[];
  t.after(async()=>{
    for(const client of clients) await client.suspend();
    rmSync(dir,{recursive:true,force:true});
  });
  const ca=join(dir,'ca.crt'), stateDir=join(dir,'state');
  writeFileSync(ca,'test certificate');
  const cfg={name:'Windows test',url:'https://127.0.0.1:31844',ca,stateDir,projects:[{label:'Default',path:defaultPath}]};
  const remote={user:{id:1,username:'member'},deviceId:randomUUID(),token:randomBytes(32).toString('base64url'),
    logins:0,leases:0,logouts:0,states:0,projects:new Map()};
  const identity=new Map([[defaultPath.toLowerCase(),'default-id'],[addedPath.toLowerCase(),'other-id']]);
  function project(input) {
    if (!remote.projects.has(input.localId)) remote.projects.set(input.localId,{...input,id:randomUUID(),deviceId:remote.deviceId});
    return remote.projects.get(input.localId);
  }
  const workspace={
    launcher:()=>()=>{},
    identifyRoot:path=>{
      const pinned=identity.get(path.toLowerCase());
      if(!pinned) throw Error('PATH_DENIED');
      return pinned;
    },
    // The native DPAPI helper is covered by the installed Windows flow.
    loginProtection:{seal:bytes=>Buffer.from(bytes).reverse(),open:bytes=>Buffer.from(bytes).reverse()}
  };
  const peer={port:31844,starts:0,probes:0,stops:0,
    async start(){this.starts++;this.child={};},
    async ready(){this.probes++;if(this.unreachable) throw Error('WINDOWS_TUNNEL_NOT_READY');},
    async stop(){this.child=null;this.stops++;}
  };
  async function bootstrap(route,data,token) {
    if(route==='/api/auth/login') {
      remote.logins++;
      for(const p of data.projects) project(p);
      return {...remote,projects:[...remote.projects.values()]};
    }
    assert.equal(token,remote.token);
    if (route==='/api/device/network') {
      remote.leases++;
      if (remote.noLease) throw Error('NETWORK_TIMEOUT');
      return {};
    }
    assert.equal(route,'/api/auth/logout');
    remote.logouts++;
    return {};
  }
  t.mock.method(DeviceClient.prototype,'verifiedState',async saved=>{
    assert.equal(saved.token,remote.token);
    remote.states++;
    if (remote.stateOffline) throw Error('NETWORK_TIMEOUT');
    if (remote.expired) throw Error('LOGIN_REQUIRED');
    return {user:remote.user,deviceId:remote.deviceId,sessions:[],devices:[],
      projects:[...remote.projects.values()].map(p=>({...p,ready:false,mode:'revoked'}))};
  });
  t.mock.method(DeviceClient.prototype,'connect',function() {this.presence??={readyState:1,terminate(){}};});
  t.mock.method(DeviceClient.prototype,'connectProject',()=>{});
  class Client extends WindowsClient {
    constructor(){
      super(cfg,workspace,{peer,privatePaths:[String.raw`C:\AnywhereCodingLab`],bootstrap});
      clients.push(this);
    }
    async api(method,route,input) {
      if (method==='DELETE' && route.startsWith('/api/device/workspaces/')) {
        const wsId=route.split('/').at(-1);
        for (const [localId,p] of remote.projects) if (p.id===wsId) remote.projects.delete(localId);
        return {ok:true,id:wsId};
      }
      assert.equal(method,'POST');
      if (route==='/api/sessions') return input;
      assert.equal(route,'/api/device/workspaces');
      assert.deepEqual(Object.keys(input).sort(),['label','localId']);
      const mapped=project(input);
      if (remote.dropRegistration) throw Error('NETWORK_TIMEOUT');
      return mapped;
    }
  }
  return {Client,remote,peer,identity,stateDir};
}

test('Windows retries each post-authentication stage without resubmitting credentials or replacing a negotiating peer',async t=>{
  const {Client,remote,peer,stateDir}=fixture(t);
  const client=new Client();
  await client.control('login',credentials);
  const vault=join(stateDir,'login.dpapi');
  assert.ok(existsSync(vault));
  assert.ok(!readFileSync(vault,'utf8').includes(remote.token));
  assert.equal(remote.leases,0);
  assert.equal(client.presence,undefined);

  remote.noLease=true;
  await assert.rejects(client.control('state'),/WINDOWS_NETWORK_CONFIG_UNAVAILABLE/);
  remote.noLease=false;peer.unreachable=true;client.retryNetworkAt=0;
  await assert.rejects(client.control('state'),/WINDOWS_TUNNEL_NOT_READY/);
  peer.unreachable=false;remote.stateOffline=true;client.retryNetworkAt=0;
  await assert.rejects(client.control('state'),/WINDOWS_STATE_UNAVAILABLE/);
  remote.stateOffline=false;client.retryNetworkAt=0;
  assert.equal((await client.control('state')).deviceId,remote.deviceId);
  assert.equal(remote.logins,1);
  assert.equal(remote.leases,2);
  assert.equal(peer.starts,1);
  assert.equal(peer.stops,0);

  // An open device WebSocket must not suppress verification after HTTPS failures.
  remote.stateOffline=true;
  await assert.rejects(client.control('state'),/WINDOWS_STATE_UNAVAILABLE/);
  client.retryNetworkAt=0;
  await assert.rejects(client.control('state'),/WINDOWS_STATE_UNAVAILABLE/);
  remote.stateOffline=false;client.retryNetworkAt=0;
  await client.enqueue(()=>client.recover(client.signed));
  assert.equal(peer.probes,3);
  assert.equal(remote.leases,2);
  assert.equal(client.presence.readyState,1);
});

test('a durable Windows login can resume first-time enrollment after the window has closed',async t=>{
  const {Client,remote,peer,stateDir}=fixture(t);
  const first=new Client();
  await first.control('login',credentials);
  await first.suspend();
  const resumed=new Client();
  remote.noLease=true;
  const pending=await resumed.control('state');
  assert.equal(pending.restoring,true);
  assert.equal(pending.connectionError,'WINDOWS_NETWORK_CONFIG_UNAVAILABLE');
  remote.noLease=false;resumed.nextRestore=resumed.retryNetworkAt=0;
  assert.equal((await resumed.control('state')).deviceId,remote.deviceId);
  assert.equal(remote.logins,1);
  assert.equal(peer.starts,1);
  remote.expired=true;
  assert.equal((await resumed.control('state')).user,null);
  assert.ok(!existsSync(join(stateDir,'login.dpapi')));
});

test('selected folders reserve stable IDs across dropped responses and restarts',async t=>{
  const {Client,remote,identity,stateDir}=fixture(t);
  const client=new Client();
  assert.throws(()=>contract.validate('registerWorkspace',{path:addedPath}),/INVALID_FIELDS/);
  await client.control('login',credentials);
  const initial=(await client.control('state')).projects[0];
  const choose=path=>client.control('registerWorkspace',{path});
  await assert.rejects(choose(String.raw`C:\AnywhereCodingLab\state`),/WORKSPACE_PATH_RESERVED/);
  remote.dropRegistration=true;
  await assert.rejects(choose(addedPath),/NETWORK_TIMEOUT/);
  const persisted=JSON.parse(readFileSync(join(stateDir,'installation.json'),'utf8')).projects[1];
  assert.equal(persisted.path,addedPath);
  remote.dropRegistration=false;
  const second=await choose(addedPath.toLowerCase());
  assert.equal((await choose(addedPath)).id,second.id);
  assert.equal(second.localId,persisted.localId);
  assert.notEqual(initial.id,second.id);
  assert.equal(second.label,'第二个项目');
  assert.equal(second.localMode,'revoked');
  await client.control('permission',{workspaceId:second.id,mode:'read'});
  await client.suspend();

  const reopened=new Client();
  const state=await reopened.control('state');
  assert.deepEqual(state.projects.map(p=>p.id),[initial.id,second.id]);
  assert.equal(state.projects[1].localMode,'read');
  assert.equal(state.projects[1].localPath,addedPath);
  await reopened.suspend();
  identity.set(addedPath.toLowerCase(),'different-inode');
  const moved=new Client();
  const projects=(await moved.control('state')).projects;
  assert.equal(projects[1].id,second.id);
  assert.equal(projects[1].localUnavailable,true);
  assert.equal(projects[1].ready,false);
  await assert.rejects(moved.control('registerWorkspace',{path:addedPath}),/WORKSPACE_ROOT_CHANGED/);
  const create=workspaceId=>moved.control('create',{workspaceId,title:'New chat',requestId:randomUUID()});
  await assert.rejects(create(second.id),/WORKSPACE_ROOT_CHANGED/);
  assert.equal((await create(initial.id)).workspaceId,initial.id);
  await assert.rejects(moved.control('removeWorkspace',{workspaceId:initial.id}),/DEFAULT_WORKSPACE_PROTECTED/);
  const removed=await moved.control('removeWorkspace',{workspaceId:second.id});
  assert.equal(removed.ok,true);
  assert.equal(JSON.parse(readFileSync(join(stateDir,'installation.json'),'utf8')).projects.length,1);
});
