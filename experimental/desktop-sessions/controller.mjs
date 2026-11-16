import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {NetworkClient} from '../../native/linux/network-helper/client.mjs';
import {control} from '../execution/control.mjs';
import contract from './contract.cjs';

export const BASE='/srv/anywhere-lab/desktop-d2';
const exec=promisify(execFile),run=async(...a)=>(await exec(a[0],a.slice(1),{timeout:20000,maxBuffer:512*1024})).stdout.trim();
const bridge=(m,p={})=>control(BASE+'/local/bridge.sock',m,p),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const units=['anywhere-desktop2-agent-a.service','anywhere-desktop2-agent-b.service','anywhere-desktop2-host.service','anywhere-desktop2-bridge.service'];
const svc=(action,...names)=>run('sudo','-n','systemctl',action,...names);
export class SessionController {
  async init(){
    await run('bash','/srv/anywhere-lab/scripts/guest-guard.sh');
    const status=await run('systemctl','show','--value','-p','ActiveState','anywhere-desktop-agent.service');if(status==='active')throw Error('CLOSE_PRIOR_DESKTOP');
    await svc('start',units[0],units[1],units[3]);await this.until(()=>bridge('state'));
    this.ready=true;return bridge('state');
  }
  async until(fn){const end=Date.now()+8000;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch{}await sleep(150);}throw Error('LOCAL_SERVICE_TIMEOUT');}
  async remoteStart(){
    if(!this.us){const h=await NetworkClient.connect('/run/anywhere-network/us.sock');try{await h.acquire();this.us=h;}catch(e){await h.close();throw e;}h.on('disconnected',()=>{if(this.us===h)this.us=null;});}
    if(!this.mockStopped){await run('docker','stop','-t','2','anywhere-helper-us-mock-1');this.mockStopped=true;}
    await svc('start',units[2]);
    if(!this.cn){const h=await NetworkClient.connect('/run/anywhere-network/cn.sock');try{await h.acquire();this.cn=h;}catch(e){await h.close();throw e;}h.on('disconnected',()=>{if(this.cn===h)this.cn=null;});}
    await bridge('enable');return bridge('state');
  }
  async request(method,params={}){
    contract.internalValidate(method,params);if(this.closing)throw Error('DESKTOP_CLOSING');
    if(method==='connect')return this.remoteStart();
    if(method==='disconnect'){await this.disconnect();return bridge('state');}
    return bridge(method,params);
  }
  async disconnect(){
    await bridge('revokeAll');await bridge('disable');
    if(this.cn){const h=this.cn;this.cn=null;await h.close();}
  }
  shutdown(){if(this.stopping)return this.stopping;
    this.stopping=(async()=>{this.closing=true;let error;
      try{if(this.ready)await this.disconnect();}catch(e){error=e;}
      await svc('stop',...units).catch(e=>{error??=e;});
      for(const h of [this.cn,this.us])if(h)await h.close().catch(e=>{error??=e;});
      if(this.mockStopped)await run('docker','start','anywhere-helper-us-mock-1').catch(e=>{error??=e;});
      if(error)throw error;return{stopped:true};})();return this.stopping;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.umask(0o077);const controller=new SessionController(),boot=controller.init();
  const send=v=>process.stdout.write(JSON.stringify(v)+'\n');boot.then(()=>send({event:'ready'})).catch(e=>send({event:'bootError',error:e.message}));
  const input=createInterface({input:process.stdin});let count=0,queue=Promise.resolve();
  input.on('line',line=>{
    let req;try{if(line.length>24000||count>=16)throw Error('FRAME_LIMIT');req=JSON.parse(line);if(!Number.isSafeInteger(req.id)||req.id<1)throw Error('INVALID_FRAME');contract.internalValidate(req.method,req.params);}catch(e){send({id:req?.id,error:e.message});return;}
    count++;const task=async()=>{try{await boot;send({id:req.id,value:await controller.request(req.method,req.params)});}catch(e){send({id:req.id,error:e.message});}finally{count--;}};
    if(['state','history'].includes(req.method))void task();else queue=queue.catch(()=>{}).then(task);
  });
  const stop=async()=>{try{await boot.catch(()=>{});await queue.catch(()=>{});await controller.shutdown();process.exit(0);}catch(e){console.error(e.message);process.exit(1);}};
  input.on('close',stop);process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
