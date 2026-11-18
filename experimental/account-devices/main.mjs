import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { serveControl } from '../execution/control.mjs';
if(hostname()!=='anywhere-crossborder-lab'||!existsSync('/etc/anywhere-crossborder-lab'))throw Error('LAB_GUEST_REQUIRED');
process.umask(0o077);
const role=process.argv[2], config=JSON.parse(readFileSync(process.argv[3],'utf8'));
let close;
if(role==='server') {
  if(process.env.DATA_DIR!==config.stateDir+'/auth')throw Error('ISOLATED_AUTH_DATABASE_REQUIRED');
  const {startServer}=await import('./host.mjs');
  const host=await startServer(config);close=()=>host.close();
} else if(role==='client') {
  const {DeviceClient}=await import('./client.mjs');
  const client=new DeviceClient(config);
  const endpoint=await serveControl(config.controlSocket,{async control(m,p){
    try {return await client.control(m,p);} catch(e){if(!e.code && /^[A-Z0-9_]+$/.test(e.message))e.code=e.message;throw e;}
  }});
  close=async()=>{endpoint.close();await client.control('logout',{});};
} else throw Error('INVALID_ROLE');
console.log('Account device '+role+' ready');
if(process.env.NOTIFY_SOCKET)execFileSync('/usr/bin/systemd-notify',['--ready']);
let closing=false;
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{if(closing)return;closing=true;await close();process.exit(0);});
