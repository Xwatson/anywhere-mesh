import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { WebSocketServer, WebSocket } from '../execution/node_modules/ws/wrapper.mjs';
import { Journal } from '../execution/journal.mjs';
import { Broker } from '../execution/broker.mjs';
import { Rpc } from '../execution/rpc.mjs';
import { serveControl } from '../execution/control.mjs';
import { CAPABILITIES } from '../execution/protocol.mjs';
import { register } from '../desktop-commander/adapter.mjs';
import { SessionHost } from './runtime.mjs';
import { fields, uuid } from './store.mjs';

if(hostname()!=='anywhere-crossborder-lab'||!existsSync('/etc/anywhere-crossborder-lab'))throw Error('LAB_GUEST_REQUIRED');
const cfg=JSON.parse(readFileSync(process.argv[2],'utf8'));
register();CAPABILITIES.push('workspace.grants.v1','history.archive.v1','review.v1');
const stores=[],brokers=new Map(),controls=[];
for(const w of cfg.workspaces){
  const store=new Journal(w.brokerDir+'/journal.sqlite'),broker=new Broker(store,w.grant,{workspace:{label:w.label,reliability:true}});
  stores.push(store);brokers.set(w.id,broker);controls.push(await serveControl(w.brokerDir+'/control.sock',broker));
}
const host=new SessionHost(cfg);host.start();
const fingerprint=path=>new X509Certificate(readFileSync(path)).fingerprint256;
const desktopPin=fingerprint(cfg.desktopCert),agentPins=new Map(cfg.workspaces.map(w=>[w.id,fingerprint(w.agentCert)]));
const authorized=(socket,pin)=>socket.authorized&&socket.getPeerCertificate().fingerprint256===pin;
const respond=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
async function body(req){let value='';for await(const c of req){value+=c;if(Buffer.byteLength(value)>20000)throw Error('BODY_LIMIT');}return JSON.parse(value);}
const server=https.createServer({cert:readFileSync(cfg.cert),key:readFileSync(cfg.key),ca:readFileSync(cfg.ca),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},async(req,res)=>{
  if(!authorized(req.socket,desktopPin)||req.headers.origin){respond(res,403,{error:'CLIENT_IDENTITY_DENIED'});return;}
  try{
    const url=new URL(req.url,'https://fixed.invalid');let value;
    if(req.method==='GET'&&url.pathname==='/api/workspaces'&&!url.search)value={deviceId:cfg.deviceId,accountId:cfg.accountId,workspaces:await host.projectStates(),mock:true};
    else if(req.method==='GET'&&url.pathname==='/api/sessions'&&!url.search)value=host.sessions();
    else if(req.method==='POST'&&url.pathname==='/api/sessions'&&!url.search)value=host.create(await body(req));
    else{
      const m=url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/(events|messages|stop|turns\/[a-f0-9-]{36})$/);
      const q=url.pathname.match(/^\/api\/requests\/([a-f0-9-]{36})$/);
      if(q&&req.method==='GET'&&!url.search){uuid(q[1]);value=host.store.get('requests',q[1])?.result??null;}
      else if(m){
        host.session(m[1]);
        if(req.method==='GET'&&m[2]==='events'){
          if([...url.searchParams.keys()].some(k=>k!=='afterSeq')||url.searchParams.getAll('afterSeq').length>1)throw Error('INVALID_CURSOR');
          value=host.store.page(m[1],Number(url.searchParams.get('afterSeq')??0));
        }else if(!url.search&&req.method==='POST'&&m[2]==='messages')value=await host.send(m[1],await body(req));
        else if(!url.search&&req.method==='POST'&&m[2]==='stop')value=await host.stop(m[1],await body(req));
        else if(!url.search&&req.method==='GET'&&m[2].startsWith('turns/')){const t=host.store.get('turns',m[2].slice(6));if(!t||t.sessionId!==m[1])throw Error('TURN_NOT_BOUND');value=host.publicTurn(t);}
        else throw Error('NOT_FOUND');
      }else throw Error('NOT_FOUND');
    }
    respond(res,200,value);
  }catch(e){respond(res,e.message==='NOT_FOUND'?404:409,{error:e.code??e.message});}
});
server.headersTimeout=7000;server.requestTimeout=10000;server.maxConnections=24;server.on('tlsClientError',()=>{});
const deviceWss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
const chatWss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
server.on('upgrade',(req,socket,head)=>{
  const match=req.url?.match(/^\/device\/([a-f0-9-]{36})$/);
  if(match&&agentPins.has(match[1])&&authorized(socket,agentPins.get(match[1]))&&!req.headers.origin){
    const broker=brokers.get(match[1]);deviceWss.handleUpgrade(req,socket,head,ws=>{
      const rpc=new Rpc(ws,(method,params,frame)=>broker.peer(rpc,method,params,frame));
      const timer=setTimeout(()=>{if(!rpc.epoch)rpc.close();},5000);ws.on('close',()=>clearTimeout(timer));
    });
  }else if(req.url==='/ws'&&authorized(socket,desktopPin)&&!req.headers.origin){
    chatWss.handleUpgrade(req,socket,head,ws=>{
      ws.subscriptions=new Map();ws.alive=true;ws.on('pong',()=>{ws.alive=true;});
      ws.on('message',raw=>{
        try{
          const msg=JSON.parse(raw);fields(msg,['t','sessionId','historyEpoch','afterSeq']);
          if(msg.t!=='sub')throw Error('INVALID_STREAM_REQUEST');
          const s=host.session(msg.sessionId);if(s.historyEpoch!==msg.historyEpoch)throw Error('HISTORY_EPOCH_CHANGED');
          host.store.page(s.id,msg.afterSeq);if(!ws.subscriptions.has(s.id)&&ws.subscriptions.size>=50)throw Error('SUBSCRIPTION_LIMIT');
          ws.subscriptions.set(s.id,msg.afterSeq);sendPage(ws,s.id);
        }catch(e){ws.close(4400,e.message.slice(0,100));}
      });
    });
  }else socket.destroy();
});
function sendPage(ws,id){
  if(ws.readyState!==WebSocket.OPEN||!ws.subscriptions.has(id))return;
  if(ws.bufferedAmount>262144){ws.close(4408,'SLOW_CONSUMER');return;}
  const page=host.store.page(id,ws.subscriptions.get(id));
  if(page.events.length)ws.send(JSON.stringify({t:'events',...page}));
}
host.on('events',id=>{for(const ws of chatWss.clients)sendPage(ws,id);});
const heartbeat=setInterval(()=>{for(const ws of chatWss.clients){if(!ws.alive)ws.terminate();else{ws.alive=false;ws.ping();}}},3000);
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(cfg.port,cfg.host,resolve);});
console.log(JSON.stringify({role:'mock-session-host',host:cfg.host,port:cfg.port,workspaces:cfg.workspaces.length,realCli:false}));
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{
  if(closing)return;closing=true;clearInterval(heartbeat);
  for(const ws of chatWss.clients)ws.terminate();for(const ws of deviceWss.clients)ws.terminate();
  await host.close();for(const b of brokers.values())b.close();for(const c of controls)c.close();
  for(const s of stores)s.close();server.close();process.exit(0);
});
