import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import { WebSocketServer } from '../execution/node_modules/ws/wrapper.mjs';
import { Broker } from '../execution/broker.mjs';
import { Journal } from '../execution/journal.mjs';
import { Rpc } from '../execution/rpc.mjs';
import { serveControl } from '../execution/control.mjs';
import { grantFor } from '../execution/grants.mjs';
import { SessionHost } from '../session-host/runtime.mjs';
import { fields, uuid } from '../session-host/store.mjs';
import { register } from '../desktop-commander/adapter.mjs';
import { CAPABILITIES } from '../execution/protocol.mjs';
import * as directory from './directory.mjs';

register();
CAPABILITIES.push('workspace.grants.v1', 'history.archive.v1', 'review.v1');

export async function startServer(config) {
  const CodexTurns = config.codexSocket ? (await import('../session-host/codex-turns.mjs')).CodexTurns : null;
  const accounts = new Map(), projects = new Map(), opening = new Map(), online = new Map();
  const socketServer = new WebSocketServer({ noServer:true, perMessageDeflate:false, maxPayload:65536 });
  function account(id) {
    if (!accounts.has(id)) {
      const stateDir = join(config.stateDir,'u'+id);
      const host = new SessionHost({stateDir, accountId:String(id), requireDeviceBinding:true,
        workspaces:[], mcpPath:config.mcpPath});
      if (CodexTurns) host.codex = new CodexTurns(host,config.codexSocket,config.codexCwd);
      accounts.set(id,host);
    }
    return accounts.get(id);
  }
  async function openProject(id, project) {
    const host = account(id);
    if (projects.has(project.id)) { host.workspaces.get(project.id).label = project.label; return; }
    if (opening.has(project.id)) return opening.get(project.id);
    const grant = grantFor({deviceId:project.deviceId, accountId:String(id), workspaceId:project.id}, 'revoked', 1);
    const w = {...project, brokerDir:join(host.config.stateDir,project.id), grant};
    const task = (async () => {
      mkdirSync(w.brokerDir,{recursive:true,mode:0o700});
      const store = new Journal(join(w.brokerDir,'journal.sqlite'));
      const broker = new Broker(store,grant,{workspace:{label:w.label,reliability:true}});
      try {
        const control = await serveControl(join(w.brokerDir,'control.sock'),broker);
        projects.set(w.id,{broker,store,control});
        host.workspaces.set(w.id,w);
      } catch (e) { broker.close(); store.close(); throw e; }
    })();
    opening.set(w.id,task);
    try { await task; } finally { opening.delete(w.id); }
  }
  async function prepare(id) {
    const host = account(id);
    for (const p of directory.workspaces(id)) await openProject(id,p);
    if (!host.timer) host.start();
    return host;
  }
  for (const userId of directory.accountIds()) await prepare(userId);

  function detach(id, current = online.get(id)) {
    if (!current || online.get(id) !== current) return;
    online.delete(id);
    for (const ws of current.tools) ws.terminate();
    current.socket.terminate();
    // Use the last authenticated heartbeat, including when a silent link times out.
    directory.seen(id,current.lastSeen);
  }
  function deviceRows(id) {
    return directory.devices(id).map(d => ({...d, disabled:Boolean(d.disabled), online:online.has(d.id),
      lastSeen:online.get(d.id)?.lastSeen ?? d.lastSeen}));
  }
  function workspaceRows(userId, thisDevice) {
    return directory.workspaces(userId).map(p => {
      const broker = projects.get(p.id)?.broker;
      return { id:p.id, label:p.label, deviceId:p.deviceId, ready:online.has(p.deviceId) && broker?.phase==='ready',
        mode:broker?.grant.mode ?? 'revoked', ...(p.deviceId===thisDevice ? {localId:p.localId} : {}) };
    });
  }
  const cookieName = 'anywhere_device_session';
  function credential(req) {
    const header = req.headers.authorization;
    return header ? header.replace(/^Bearer /,'') :
      (req.headers.cookie ?? '').split(';').map(p=>p.trim()).find(p=>p.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  }
  function json(res,status,value) {
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw Error('INVALID_FIELDS');
    const parts=[]; let bytes=0;
    for await (const part of req) {
      bytes+=part.length; if(bytes>20000) throw Error('BODY_LIMIT'); parts.push(part);
    }
    try { return JSON.parse(Buffer.concat(parts)); } catch { throw Error('INVALID_FIELDS'); }
  }
  const assets = new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/thread.js',['thread.js','text/javascript']],['/style.css',['style.css','text/css']]]);
  async function handle(req,res) {
    const url=new URL(req.url,'https://local.invalid'), path=url.pathname;
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.origin && req.headers.origin !== 'https://'+req.headers.host) throw Error('FORBIDDEN');
    if (req.method==='GET' && assets.has(path)) {
      const [name,type]=assets.get(path);
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});
      res.end(readFileSync(new URL('./ui/'+name,import.meta.url))); return;
    }
    if (path==='/api/auth/login' && req.method==='POST') {
      const signed=directory.login(await body(req),req.socket.remoteAddress);
      if (signed.deviceId) {
        detach(signed.deviceId);
        await prepare(signed.user.id);
      } else {
        res.setHeader('Set-Cookie',cookieName+'='+signed.token+'; Path=/; HttpOnly; SameSite=Strict; Secure');
      }
      json(res,200,{user:signed.user, deviceId:signed.deviceId, ...(signed.deviceId ? {token:signed.token,
        projects:directory.workspaces(signed.user.id).filter(p=>p.deviceId===signed.deviceId)} : {})}); return;
    }
    const token=credential(req), {user,deviceId}=directory.authenticate(token);
    if (req.method==='POST' && path==='/api/auth/logout') {
      fields(await body(req),[]); directory.logout(token); if(deviceId) detach(deviceId);
      res.setHeader('Set-Cookie',cookieName+'=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure');
      json(res,200,{ok:true}); return;
    }
    if (path.startsWith('/api/admin/')) {
      if (!user.isAdmin) throw Error('FORBIDDEN');
      if (req.method==='GET' && path==='/api/admin/devices') {
        const rows=deviceRows().map(d=>({...d,sessions:account(d.userId).sessions().filter(s=>s.deviceId===d.id)
          .map(s=>({id:s.id,title:s.title}))}));
        json(res,200,rows); return;
      }
      const target=path.match(/^\/api\/admin\/devices\/([a-f0-9-]{36})$/);
      if (target && req.method==='POST') {
        const b=await body(req); fields(b,['disabled']); directory.setDisabled(target[1],b.disabled);
        if(b.disabled) detach(target[1]); json(res,200,{ok:true}); return;
      }
      throw Error('NOT_FOUND');
    }
    const host=account(user.id);
    if (req.method==='GET' && path==='/api/state') {
      json(res,200,{user,deviceId,chatEngine:host.codex?'codex':'mock',devices:deviceRows(user.id),projects:workspaceRows(user.id,deviceId),sessions:host.sessions()}); return;
    }
    if (req.method==='POST' && path==='/api/sessions') {
      const input=await body(req); fields(input,['workspaceId','title','requestId']);
      const w=host.workspace(input.workspaceId);
      if (!deviceId || w.grant.deviceId!==deviceId) throw Error('CREATE_ON_THIS_DEVICE');
      json(res,200,host.create(input)); return;
    }
    const match=path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/(events|messages|stop)$/);
    if (!match) throw Error('NOT_FOUND');
    const s=host.session(match[1]);
    if (req.method==='GET' && match[2]==='events') {
      json(res,200,host.store.page(s.id,Number(url.searchParams.get('afterSeq')??0))); return;
    }
    if (req.method==='POST' && match[2]==='messages') {
      const b=await body(req); fields(b,['requestId','text']);
      const prior=host.store.request(b.requestId,{kind:'send',sessionId:s.id,text:b.text});
      if (!prior && !online.has(s.deviceId)) throw Error('DEVICE_OFFLINE');
      json(res,200,prior ?? await host.send(s.id,b)); return;
    }
    if (req.method==='POST' && match[2]==='stop') { json(res,200,await host.stop(s.id,await body(req))); return; }
    throw Error('NOT_FOUND');
  }
  const server=https.createServer({cert:readFileSync(config.cert),key:readFileSync(config.key),minVersion:'TLSv1.3'},(req,res)=>{
    handle(req,res).catch(e=>{
      const message=e.code ?? e.message;
      const status={LOGIN_REQUIRED:401,INVALID_CREDENTIALS:401,FORBIDDEN:403,DEVICE_DISABLED:403,CREATE_ON_THIS_DEVICE:403,
        NOT_FOUND:404,SESSION_NOT_FOUND:404,LOGIN_THROTTLED:429,INVALID_FIELDS:400,BODY_LIMIT:413}[message] ?? 409;
      json(res,status,{error:/^[A-Z0-9_]+$/.test(message)?message:'REQUEST_FAILED'});
    });
  });
  server.on('upgrade',(req,socket,head)=>{
    try {
      if (req.headers.origin || !req.headers.authorization?.startsWith('Bearer ')) throw Error('FORBIDDEN');
      const token=credential(req), {user,deviceId}=directory.authenticate(token);
      if (!deviceId) throw Error('FORBIDDEN');
      if (req.url==='/ws/device') {
        socketServer.handleUpgrade(req,socket,head,ws=>{
          detach(deviceId);
          const current={socket:ws,token,lastSeen:Date.now(),saved:Date.now(),tools:new Set()};
          online.set(deviceId,current); directory.seen(deviceId);
          ws.on('pong',()=>{
            if (online.get(deviceId)!==current) return;
            current.lastSeen=Date.now();
            if (current.lastSeen-current.saved>=10000) {directory.seen(deviceId,current.lastSeen);current.saved=current.lastSeen;}
          });
          ws.on('message',()=>ws.close(1008));
          ws.on('close',()=>detach(deviceId,current)); ws.on('error',()=>{});
        }); return;
      }
      const m=req.url?.match(/^\/ws\/projects\/([a-f0-9-]{36})$/);
      const w=m && account(user.id).workspaces.get(uuid(m[1])), current=online.get(deviceId);
      if (!w || w.grant.deviceId!==deviceId || !current || current.token!==token) throw Error('FORBIDDEN');
      const broker=projects.get(w.id).broker;
      socketServer.handleUpgrade(req,socket,head,ws=>{
        current.tools.add(ws);
        const rpc=new Rpc(ws,(method,params,frame)=>{
          if (current!==online.get(deviceId)) throw Error('STALE_CONNECTION');
          directory.authenticate(token);
          return broker.peer(rpc,method,params,frame);
        });
        const timer=setTimeout(()=>{if (!rpc.epoch) rpc.close();},5000);
        ws.on('close',()=>{clearTimeout(timer);current.tools.delete(ws);});
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  const heartbeat=setInterval(()=>{
    for (const [id,p] of online) {
      try {
        directory.authenticate(p.token);
        if (Date.now()-p.lastSeen>8000) detach(id,p); else p.socket.ping();
      } catch {detach(id,p);}
    }
  },2000);
  server.headersTimeout=8000; server.requestTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
  return {port:server.address().port, async close(){
    clearInterval(heartbeat);
    for(const id of online.keys()) detach(id);
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    for(const host of accounts.values()) await host.close();
    for(const p of projects.values()) {p.broker.close();p.control.close();p.store.close();}
    socketServer.close();
  }};
}
