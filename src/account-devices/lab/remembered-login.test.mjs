import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeviceClient} from '../client.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'device-login-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const ca=join(dir,'ca.crt'),path=join(dir,'project');
  mkdirSync(path);writeFileSync(ca,'test certificate');
  const cfg={url:'https://service.invalid',stateDir:join(dir,'state'),name:'Test device',ca,projects:[{path,label:'Project'}]};
  let session,projects;
  const remote={offline:false,logins:0,logouts:0,id:randomUUID(),workspace:randomUUID(),userId:3};
  function state(token) {
    if(remote.offline) throw Error('NETWORK_TIMEOUT');
    if(!session || token!==session.token) throw Error('LOGIN_REQUIRED');
    return {user:session.user,deviceId:remote.id,projects:structuredClone(projects),sessions:[],devices:[]};
  }
  class Client extends DeviceClient {
    constructor(){super(cfg,{launcher:()=>()=>{}});}
    async authenticate(input) {
      remote.logins++;
      session={user:{id:remote.userId,username:input.username},deviceId:remote.id,token:randomBytes(32).toString('base64url')};
      projects=input.projects.map(p=>({...p,id:remote.workspace,deviceId:remote.id}));
      return {...session,projects};
    }
    verifiedState(saved) {return state(saved.token);}
    api(){return state(this.signed.token);}
    remoteLogout(signed){if(remote.offline) return Promise.reject(Error('NETWORK_TIMEOUT'));if(session?.token===signed.token) session=null; remote.logouts++;return Promise.resolve();}
    connect(){this.connections=(this.connections??0)+1;}
  }
  return {Client,remote,cfg,vault:join(cfg.stateDir,'login.json'),expire:()=>{session=null;}};
}
const enter=client=>client.control('login',{username:'member',password:'only-entered-on-first-launch'});

test('close, process restart and explicit logout use different lifetimes',async t=>{
  const {Client,remote,vault}=fixture(t);
  const first=new Client();
  assert.equal((await first.control('state')).user,null);
  await enter(first);
  await first.control('permission',{workspaceId:remote.workspace,mode:'edit'});
  await first.suspend();
  assert.equal(first.locals.size,0);assert.equal(remote.logouts,0);
  assert.equal(statSync(vault).mode & 0o777,0o600);
  assert.ok(!readFileSync(vault,'utf8').includes('only-entered-on-first-launch'));
  const reopened=new Client();
  const current=await reopened.control('state');
  assert.equal(current.deviceId,remote.id);assert.equal(current.projects[0].localMode,'edit');
  assert.equal(remote.logins,1);
  await reopened.control('logout');assert.equal(remote.logouts,1);assert.ok(!existsSync(vault));
  const fresh=new Client();
  assert.equal((await fresh.control('state')).user,null);
  await enter(fresh);
  assert.equal((await fresh.control('state')).projects[0].localMode,'revoked');
  await fresh.control('logout');
});

test('a temporary disconnect keeps the login, a revoked token clears it before any device connects',async t=>{
  const {Client,remote,vault,expire}=fixture(t);
  const first=new Client();await enter(first);await first.suspend();
  remote.offline=true;
  const reopened=new Client();
  assert.equal((await reopened.control('state')).restoring,true);
  assert.ok(existsSync(vault));assert.equal(reopened.connections,undefined);
  remote.offline=false;reopened.nextRestore=0;
  assert.equal((await reopened.control('state')).user.id,3);assert.equal(reopened.connections,1);
  await reopened.suspend();expire();
  const revoked=new Client();
  assert.equal((await revoked.control('state')).user,null);
  assert.ok(!existsSync(vault));assert.equal(revoked.connections,undefined);
});

test('a saved login must match the account and device in the verified server response',async t=>{
  const {Client,remote,vault}=fixture(t);
  const client=new Client();await enter(client);await client.suspend();
  remote.id=randomUUID();
  const other=new Client();
  assert.equal((await other.control('state')).user,null);
  assert.equal(other.connections,undefined);assert.ok(!existsSync(vault));
});

test('an offline user can forget a saved session without reopening any tools',async t=>{
  const {Client,remote,vault}=fixture(t);
  const client=new Client();await enter(client);await client.suspend();
  remote.offline=true;
  const reopened=new Client();await reopened.control('logout');
  assert.equal((await reopened.control('state')).user,null);
  assert.ok(!existsSync(vault));assert.equal(reopened.connections,undefined);
});
