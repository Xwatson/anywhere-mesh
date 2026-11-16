import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import WebSocket from '../../execution/node_modules/ws/wrapper.mjs';
import {Remote} from '../remote.mjs';
const desktop=JSON.parse(readFileSync('/etc/anywhere-desktop2/desktop/config.json','utf8')),agent=JSON.parse(readFileSync('/etc/anywhere-desktop2/agent-a/config.json','utf8'));
const remote=new Remote({...desktop,cert:agent.cert,key:agent.key});
await assert.rejects(remote.request('GET','/api/sessions'),/CLIENT_IDENTITY_DENIED/);
await new Promise((resolve,reject)=>{
 const ws=new WebSocket('wss://10.126.10.2:8443/device/'+desktop.workspaces[1].id,{...remote.options,handshakeTimeout:4000});
 ws.once('open',()=>{ws.terminate();reject(Error('AGENT_CROSSED_WORKSPACE'));});ws.once('error',()=>resolve());
});
console.log('agent certificate cannot call desktop API or attach to another workspace');
