import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { control } from '../../execution/control.mjs';
if(hostname()!=='anywhere-crossborder-lab')throw Error('LAB_GUEST_REQUIRED');
const base='/srv/anywhere-lab/d3', users=JSON.parse(readFileSync(base+'/test/accounts.json'));
const [admin,coder,other]=users,ca=readFileSync('/etc/anywhere-d3/ca.crt');
const rpc=slot=>(m,p={})=>control(base+'/local/'+slot+'/control.sock',m,p);
const A=rpc('a'),B=rpc('b'),checkpoints=[];
const record=name=>{checkpoints.push(name);console.log(name);};
const wait=async(f,ms=28000)=>{
  let issue;const end=Date.now()+ms;
  while(Date.now()<end){try{const result=await f();if(result)return result;}catch(e){issue=e;}
    await new Promise(r=>setTimeout(r,200));}
  throw Error('Timed out: '+(issue?.message??f.toString().slice(0,150)));
};
function web(method,path,body,cookie) {
  return new Promise((resolve,reject)=>{
    const req=https.request('https://10.126.10.2:8443'+path,{method,ca,timeout:6000,headers:{
      ...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})}},res=>{
      let raw='';res.on('data',s=>{raw+=s;});res.on('end',()=>resolve({code:res.statusCode,
        value:res.headers['content-type']?.startsWith('application/json')?JSON.parse(raw):raw,
        cookie:res.headers['set-cookie']?.[0].split(';')[0]}));
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('NETWORK_TIMEOUT')));req.end(body?JSON.stringify(body):undefined);
  });
}
const service=(...args)=>execFileSync('sudo',['-n','systemctl',...args],{timeout:30000});
const file=slot=>execFileSync('sudo',['-n','-u','anywhere-d3-'+slot,'cat',base+'/project-'+slot+'/notes.txt'],{encoding:'utf8'});
const turn=async(client,s,text)=>{
  const id=randomUUID(),r=await client('send',{requestId:id,sessionId:s.id,text});
  const p=await wait(async()=>{
    const page=await client('history',{sessionId:s.id,afterSeq:r.acceptedSeq-1});
    const row=page.events.findLast(e=>e.event.type==='tool_call'&&e.event.id===r.turnId);
    if(!page.events.some(e=>e.event.type==='turn_end')||!row)return;
    const info=(await client('state')).sessions.find(x=>x.id===s.id);
    if(!info.activeTurn)return row.event;
  });
  assert.equal(p.status,'completed',p.output);
  return {output:p.output,requestId:id,result:r};
};
const ready=(client,id,mode)=>wait(async()=>{
  const s=await client('state'),p=s.projects.find(p=>p.id===id);
  return p?.ready&&p.mode===mode;
});
const label='D3-'+Date.now(),reportPath=process.argv[2];
let paused=false;
try {
  await wait(()=>A('state'));await wait(()=>B('state'));
  await A('logout');await B('logout');
  const anon=await web('GET','/api/admin/devices');assert.equal(anon.code,401);
  const browser=await web('POST','/api/auth/login',admin);assert.equal(browser.code,200);assert.ok(browser.cookie);
  assert.equal(browser.value.deviceId,null);assert.equal(browser.value.token,undefined);
  assert.match((await web('GET','/')).value,/设备管理/);
  const a=await A('login',coder);const sa=await A('state'),pa=sa.projects.find(p=>p.deviceId===a.deviceId);
  await ready(A,pa.id,'revoked');await A('permission',{workspaceId:pa.id,mode:'edit'});await ready(A,pa.id,'edit');
  const s1=await A('create',{workspaceId:pa.id,title:label+' · 会话 1',requestId:randomUUID()});
  assert.equal(s1.deviceId,a.deviceId);assert.equal(s1.accountId,String(a.user.id));
  record('账号登录自动上线，创建会话时持久绑定本机和工作区');
  const b=await B('login',coder);assert.notEqual(a.deviceId,b.deviceId);
  const sb=await B('state'),pb=sb.projects.find(p=>p.deviceId===b.deviceId);
  assert.equal(sb.sessions.find(s=>s.id===s1.id).deviceId,a.deviceId);
  await B('permission',{workspaceId:pb.id,mode:'edit'});await ready(B,pb.id,'edit');
  const s2=await B('create',{workspaceId:pb.id,title:label+' · 会话 2',requestId:randomUUID()});
  assert.equal(s2.deviceId,b.deviceId);
  const ra=await turn(B,s1,'/read notes.txt'),rb=await turn(A,s2,'/read notes.txt');
  assert.match(ra.output,/ONLY_DEVICE_A/);assert.doesNotMatch(ra.output,/ONLY_DEVICE_B/);
  assert.match(rb.output,/ONLY_DEVICE_B/);assert.doesNotMatch(rb.output,/ONLY_DEVICE_A/);
  const marker='d3-'+randomUUID(),text='/append notes.txt '+marker;
  const write=await turn(B,s1,text);
  const duplicate=await A('send',{sessionId:s1.id,requestId:write.requestId,text});
  assert.equal(duplicate.turnId,write.result.turnId);
  assert.equal(file('a').split(marker).length-1,1);assert.ok(!file('b').includes(marker));
  record('B 操作 A 的会话真实读写 A，A 操作 B 的会话读取 B，跨端重试只写一次');
  await assert.rejects(B('create',{workspaceId:pa.id,title:'错误目标',requestId:randomUUID()}),/ONLY_ON_BOUND_DEVICE/);
  await assert.rejects(B('permission',{workspaceId:pa.id,mode:'execute'}),/ONLY_ON_BOUND_DEVICE/);
  await assert.rejects(B('admin'),/FORBIDDEN/);
  const memberWeb=await web('POST','/api/auth/login',coder);
  assert.equal((await web('POST','/api/sessions',{workspaceId:pa.id,title:'网页没有本机项目',requestId:randomUUID()},memberWeb.cookie)).code,403);
  const override=await web('POST','/api/sessions/'+s1.id+'/messages',{
    requestId:randomUUID(),text:'/read notes.txt',deviceId:b.deviceId,workspaceId:pb.id
  },memberWeb.cookie);
  assert.equal(override.code,400);
  await web('POST','/api/auth/logout',{},memberWeb.cookie);
  const managed=await web('GET','/api/admin/devices',null,browser.cookie);
  const da=managed.value.find(d=>d.id===a.deviceId),db=managed.value.find(d=>d.id===b.deviceId);
  assert.ok(da.online&&db.online);assert.ok(da.sessions.some(s=>s.id===s1.id)&&db.sessions.some(s=>s.id===s2.id));
  assert.ok(!da.sessions.some(s=>s.id===s2.id));
  const stranger=await web('POST','/api/auth/login',other);
  const privateView=await web('GET','/api/state',null,stranger.cookie);
  assert.ok(!privateView.value.devices.some(d=>d.id===a.deviceId));
  assert.ok(!privateView.value.sessions.some(s=>s.id===s1.id));
  assert.equal((await web('GET','/api/sessions/'+s1.id+'/events',null,stranger.cookie)).code,404);
  assert.equal((await web('POST','/api/sessions/'+s1.id+'/messages',{requestId:randomUUID(),text:'/read notes.txt'},stranger.cookie)).code,404);
  assert.equal((await web('GET','/api/admin/devices',null,stranger.cookie)).code,403);
  await web('POST','/api/auth/logout',{},stranger.cookie);
  record('管理界面按账号列出设备和绑定会话，其他账号与普通用户权限隔离');
  service('kill','--kill-whom=main','--signal=STOP','anywhere-d3-client-a');paused=true;
  const offline=await wait(async()=>{
    const s=await B('state'),d=s.devices.find(d=>d.id===a.deviceId);
    return !d.online&&s.devices.find(d=>d.id===b.deviceId).online&&d;
  },18000);
  assert.ok(offline.lastSeen>0);assert.ok((await B('history',{sessionId:s1.id,afterSeq:0})).events.length>0);
  await assert.rejects(B('send',{sessionId:s1.id,requestId:randomUUID(),text:'/read notes.txt'}),/DEVICE_OFFLINE/);
  assert.match((await turn(B,s2,'/read notes.txt')).output,/ONLY_DEVICE_B/);
  service('kill','--kill-whom=main','--signal=CONT','anywhere-d3-client-a');paused=false;
  await ready(B,pa.id,'edit');
  record('A 失去心跳后显示离线和最近在线时间，历史可读，B 自己的会话继续执行');
  service('restart','anywhere-d3-host.service');
  await ready(B,pa.id,'edit');await ready(B,pb.id,'edit');
  assert.equal((await B('state')).sessions.find(s=>s.id===s1.id).deviceId,a.deviceId);
  assert.match((await turn(B,s1,'/read notes.txt')).output,/ONLY_DEVICE_A/);
  record('实验服务端重启，账号会话和工作区绑定恢复，原会话仍读取 A');
  const disable=flag=>web('POST','/api/admin/devices/'+a.deviceId,{disabled:flag},browser.cookie);
  assert.equal((await disable(true)).code,200);
  await wait(async()=>!(await A('state')).user);
  await assert.rejects(A('login',coder),/DEVICE_DISABLED/);
  await assert.rejects(B('send',{sessionId:s1.id,requestId:randomUUID(),text:'/read notes.txt'}),/DEVICE_OFFLINE/);
  assert.equal((await disable(false)).code,200);
  const again=await A('login',coder);assert.equal(again.deviceId,a.deviceId);await ready(B,pa.id,'revoked');
  await assert.rejects(B('send',{sessionId:s1.id,requestId:randomUUID(),text:'/read notes.txt'}),/LOCAL_PERMISSION_REQUIRED/);
  record('管理页停用只断开指定设备，恢复并重新登录沿用设备身份，工作区授权由本地决定');
  await B('logout');const otherDevice=await B('login',other);
  assert.notEqual(otherDevice.deviceId,b.deviceId);
  assert.ok(!(await B('state')).sessions.some(s=>s.id===s1.id));
  await assert.rejects(B('history',{sessionId:s1.id,afterSeq:0}),/SESSION_NOT_FOUND/);
  await B('logout');assert.equal((await B('login',coder)).deviceId,b.deviceId);
  record('同一安装切换账号后设备身份和历史隔离，登录原账号识别原设备');
  await web('POST','/api/auth/logout',{},browser.cookie);
  const report={passed:true,checkedAt:new Date().toISOString(),checks:checkpoints,simulatedDevices:2,
    transport:'EasyTier CN to US, HTTPS/WSS',mockCli:true,sessionA:s1.id,sessionB:s2.id,deviceA:a.deviceId,deviceB:b.deviceId};
  if(reportPath)writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
} finally {
  if(paused)service('kill','--kill-whom=main','--signal=CONT','anywhere-d3-client-a');
  await Promise.allSettled([A('logout'),B('logout')]);
}
