import https from 'node:https';
import tls from 'node:tls';
import {readFileSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';
import WebSocket from '../execution/node_modules/ws/wrapper.mjs';

export class Remote {
  constructor(cfg){
    this.url=cfg.url;const pin=new X509Certificate(readFileSync(cfg.serverCert)).fingerprint256;
    this.options={key:readFileSync(cfg.key),cert:readFileSync(cfg.cert),ca:readFileSync(cfg.ca),rejectUnauthorized:true,minVersion:'TLSv1.3',
      checkServerIdentity:(name,cert)=>tls.checkServerIdentity(name,cert)||(cert.fingerprint256===pin?undefined:Error('SERVER_PIN_MISMATCH'))};
  }
  request(method,path,body){return new Promise((resolve,reject)=>{
    if(!/^\/api\/[a-z0-9/?=&-]+$/i.test(path))return reject(Error('INVALID_API_PATH'));
    const raw=body===undefined?undefined:JSON.stringify(body);if(raw&&Buffer.byteLength(raw)>20000)return reject(Error('BODY_LIMIT'));
    const req=https.request(this.url+path,{...this.options,method,timeout:6000,agent:false,headers:raw?{'content-type':'application/json','content-length':Buffer.byteLength(raw)}:{}},res=>{
      const chunks=[];let size=0;res.on('data',c=>{size+=c.length;if(size>262144)req.destroy(Error('RESPONSE_LIMIT'));else chunks.push(c);});
      res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks));res.statusCode===200?resolve(data):reject(Error(data.error??'REMOTE_ERROR'));}catch(e){reject(e);}});
    });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('NETWORK_TIMEOUT')));req.end(raw);
  });}
  stream(){return new WebSocket(this.url.replace(/^https:/,'wss:')+'/ws',{...this.options,handshakeTimeout:6000,maxPayload:65536,perMessageDeflate:false});}
}
