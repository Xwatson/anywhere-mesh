import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const service = 'https://awc.xbxbe.com';
const key = /^[A-Za-z0-9+/]{43}=$/;
export function sessionConfig(profile, deviceId, port) {
  const slot = /^10\.203\.73\.(\d{1,3})\/24$/.exec(profile.ipv4)?.[1];
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/.test(deviceId) ||
      !/^[\w-]{1,64}$/.test(profile.name) || !key.test(profile.serverKey) || !key.test(profile.credential) ||
      !Number.isSafeInteger(profile.expiresAt) || !slot || Number(slot) < 4 || Number(slot) > 254 ||
      !Number.isInteger(port) || port < 1 || port > 65535) throw Error('NETWORK_ENROLLMENT_UNAVAILABLE');
  const sections = [
    ['', {credential_file:'network-server.json', instance_name:'win-'+deviceId, instance_id:deviceId, hostname:'win-'+deviceId.slice(0,8),
      dhcp:false, ipv4:profile.ipv4, listeners:[], stun_servers:[], stun_servers_v6:[]}],
    ['[network_identity]', {network_name:profile.name}],
    ['[[peer]]', {uri:'wss://awc.xbxbe.com/easytier', peer_public_key:profile.serverKey}],
    ['[[port_forward]]', {bind_addr:'127.0.0.1:'+port, dst_addr:'10.203.73.2:18443', proto:'tcp'}],
    ['[flags]', {default_protocol:'wss', enable_encryption:true, enable_ipv6:false, disable_p2p:true, need_p2p:false,
      disable_udp_hole_punching:true, disable_tcp_hole_punching:true, disable_sym_hole_punching:true, disable_upnp:true,
      enable_kcp_proxy:false, disable_kcp_input:true, disable_relay_kcp:true, enable_quic_proxy:false,
      disable_quic_input:true, disable_relay_quic:true, accept_dns:false, enable_exit_node:false, private_mode:true,
      relay_network_whitelist:profile.name, multi_thread:false, bind_device:false, no_tun:true, use_smoltcp:true}]
  ];
  return sections.map(([header,values]) => [header,...Object.entries(values).map(([k,v])=>k+' = '+JSON.stringify(v))].join('\n')).join('\n')+'\n';
}

function writeConfig(root,name,data) {
  const dest = join(root,name);
  const tmp = dest+'.'+randomUUID()+'.tmp';
  try {
    writeFileSync(tmp,data,{flag:'wx',mode:0o600});
    renameSync(tmp,dest);
  } finally { rmSync(tmp,{force:true}); }
}

async function freePort(port) {
  const server = createServer();
  await new Promise((resolve,reject) => server.once('error',reject).listen(port,'127.0.0.1',resolve));
  const selected = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return selected;
}
function probe(port,ca) {
  return new Promise(resolve => {
    const socket = tls.connect({port, host:'127.0.0.1', servername:'localhost', ca, minVersion:'TLSv1.3'});
    const finish = ok => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false),2500);
    socket.once('error',() => finish(false));
    socket.once('secureConnect',() => finish(socket.authorized));
  });
}
export class WindowsPeer {
  constructor(root,ca) {
    this.root = root; this.ca = ca;
    this.legacy = existsSync(join(root,'windows.toml'));
  }
  async start(profile,deviceId,restart=false) {
    if (!restart && this.child && (!profile || this.credential===profile.credential)) return;
    await this.stop();
    if (this.legacy) {
      this.port = await freePort(31844);
      await freePort(31897);
    } else {
      this.port = await freePort(0);
      const data = sessionConfig(profile,deviceId,this.port);
      // EasyTier 2.6.4 checks both the connector pin and its local trust store
      // before the first route exchange. This record contains only the server public key.
      const trust = {server:{pubkey:profile.serverKey, groups:[], allow_relay:false, allowed_proxy_cidrs:[],
        reusable:false, created_at_unix:Math.floor(Date.now()/1000), expiry_unix:Math.ceil(profile.expiresAt/1000)}};
      writeConfig(this.root,'network-server.json',JSON.stringify(trust));
      writeConfig(this.root,'network-session.toml',data);
    }
    const args = [join(dirname(process.execPath),'easytier-core.exe')];
    if (!this.legacy) args.push('session');
    // Only the issued credential can influence EasyTier's environment options.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ET_/i.test(k)));
    if (profile) env.ET_CREDENTIAL = profile.credential;
    const child = spawn(fileURLToPath(new URL('./PeerHost.exe',import.meta.url)),args,
      {cwd:this.root, env, stdio:['pipe','ignore','ignore'], windowsHide:true});
    this.child = child; this.credential = profile?.credential;
    child.stdin.on('error',()=>{});
    this.done = new Promise(resolve => {
      child.once('close',resolve);
      child.once('error',()=>{});
    }).then(() => {
      if (this.child===child) this.child = null;
    });
  }
  async ready(waitMs=23000) {
    const until = Date.now()+waitMs;
    do {
      if (!this.child) throw Error('WINDOWS_NETWORK_EXITED');
      if (await probe(this.port,this.ca)) return;
      await delay(300);
    } while (Date.now()<until);
    throw Error('WINDOWS_TUNNEL_NOT_READY');
  }
  async stop() {
    const child = this.child; this.child = null; this.credential = undefined;
    if (child) { child.stdin.end(); await this.done; }
  }
}
