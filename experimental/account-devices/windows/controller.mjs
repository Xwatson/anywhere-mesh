import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DeviceClient, request } from '../client.mjs';
import { service, WindowsPeer } from './network.mjs';
import { windowsWorkspace } from './read.mjs';

if (process.platform !== 'win32') throw Error('WINDOWS_REQUIRED');
const root = join(process.env.LOCALAPPDATA,'AnywhereCodingLab');
const cfg = {stateDir:join(root,'state'), name:'Windows · '+hostname(), url:'https://127.0.0.1:31844',
  ca:join(root,'ca.crt'), projects:[{label:'Windows 本地项目', path:join(root,'project')}]};
const input = createInterface({input:process.stdin});
const peer = new WindowsPeer(root,readFileSync(cfg.ca),() => {
  if (peer.legacy) { process.exitCode = 1; input.close(); process.stdin.destroy(); }
});
async function publicRequest(path,data,token) {
  try { return await request(service,{rejectUnauthorized:true,minVersion:'TLSv1.2'},'POST',path,data,token); }
  catch (error) {
    if (/^(INVALID_CREDENTIALS|LOGIN_THROTTLED|DEVICE_DISABLED|LOGIN_REQUIRED|NETWORK_ENROLLMENT_UNAVAILABLE|NETWORK_ADDRESS_LIMIT)$/.test(error.message)) throw error;
    throw Error('WINDOWS_BOOTSTRAP_UNAVAILABLE');
  }
}
class WindowsClient extends DeviceClient {
  async openNetwork(signed) {
    const profile = await publicRequest('/api/device/network',{},signed.token);
    await peer.start(profile,signed.deviceId);
    this.cfg.url = 'https://127.0.0.1:'+peer.port;
    await peer.ready();
  }
  async authenticate(params) {
    if (peer.legacy) { await peer.start(); await peer.ready(); return super.authenticate(params); }
    const signed = await publicRequest('/api/auth/login',params);
    try { await this.openNetwork(signed); return signed; }
    catch (error) {
      await peer.stop();
      await publicRequest('/api/auth/logout',{},signed.token).catch(()=>{});
      throw error;
    }
  }
  async signout(notify=true) {
    if (peer.legacy) return super.signout(notify);
    const signed = this.signed;
    try {
      await super.signout(false);
      if (notify && signed) {
        try { await request(this.cfg.url,this.tls,'POST','/api/auth/logout',{},signed.token); }
        catch { await publicRequest('/api/auth/logout',{},signed.token).catch(()=>{}); }
      }
    } finally { await peer.stop(); }
  }
  async recover(signed) {
    if (this.signed!==signed || this.presence?.readyState===1) return;
    try { await this.openNetwork(signed); }
    catch (error) { if (error.message==='LOGIN_REQUIRED') await this.signout(false); }
  }
}
const client = new WindowsClient(cfg,windowsWorkspace(fileURLToPath(new URL('./WorkspaceSnapshot.exe',import.meta.url))));
if (peer.legacy) await peer.start().catch(()=>{});
// Reissue the same login's lease after a network-service restart or a missing peer process.
const repair = setInterval(() => {
  const signed = client.signed;
  if (peer.legacy || !signed || client.presence?.readyState===1 || client.repairPending) return;
  client.repairPending = true;
  client.queue = client.queue.catch(()=>{}).then(()=>client.recover(signed)).finally(()=>{client.repairPending=false;});
},30000);
const reply = value => process.stdout.write(JSON.stringify(value)+'\n');
reply({event:'ready'});
try {
  for await (const line of input) {
    let id;
    try {
      if (line.length>24000) throw Error('INVALID_FRAME');
      const frame = JSON.parse(line); id = frame.id;
      reply({id,value:await client.control(frame.method,frame.params)});
    } catch (error) { reply({id,error:error.code ?? error.message}); }
  }
} finally {
  clearInterval(repair);
  try { await client.control('logout',{}); } finally { await peer.stop(); }
}
