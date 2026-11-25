import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeServerUrl } from '../server-config.mjs';

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

export function sessionConfig(profile, deviceId, port, serverUrl) {
  const slot = /^10\.203\.73\.(\d{1,3})\/24$/.exec(profile.ipv4)?.[1];
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/.test(deviceId) ||
      !/^[\w-]{1,64}$/.test(profile.name) || !KEY_RE.test(profile.serverKey) || !KEY_RE.test(profile.credential) ||
      !Number.isSafeInteger(profile.expiresAt) || !slot || Number(slot) < 4 || Number(slot) > 254 ||
      !Number.isInteger(port) || port < 1 || port > 65535) throw Error('NETWORK_ENROLLMENT_UNAVAILABLE');
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const wsUri = normalizedUrl.replace(/^https:/i, 'wss:') + '/easytier';
  const sections = [
    ['', {
      credential_file: 'network-server.json', instance_name: 'lin-' + deviceId, instance_id: deviceId,
      hostname: 'lin-' + deviceId.slice(0, 8), dhcp: false, ipv4: profile.ipv4,
      listeners: [], stun_servers: [], stun_servers_v6: [],
    }],
    ['[network_identity]', { network_name: profile.name }],
    ['[[peer]]', { uri: wsUri, peer_public_key: profile.serverKey }],
    ['[[port_forward]]', { bind_addr: '127.0.0.1:' + port, dst_addr: '10.203.73.2:18443', proto: 'tcp' }],
    ['[flags]', {
      default_protocol: 'wss', enable_encryption: true, enable_ipv6: false, disable_p2p: true, need_p2p: false,
      disable_udp_hole_punching: true, disable_tcp_hole_punching: true, disable_sym_hole_punching: true, disable_upnp: true,
      enable_kcp_proxy: false, disable_kcp_input: true, disable_relay_kcp: true, enable_quic_proxy: false,
      disable_quic_input: true, disable_relay_quic: true, accept_dns: false, enable_exit_node: false, private_mode: true,
      relay_network_whitelist: profile.name, multi_thread: false, bind_device: false, no_tun: true, use_smoltcp: true,
    }],
  ];
  return sections.map(([header, values]) => [header, ...Object.entries(values).map(([k, v]) => k + ' = ' + JSON.stringify(v))].join('\n')).join('\n') + '\n';
}

function writeAtomic(file, content) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

async function freePort() {
  const srv = createServer();
  await new Promise((res, rej) => srv.once('error', rej).listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  await new Promise(res => srv.close(res));
  return port;
}

function probeTls(port, ca) {
  return new Promise(resolveProbe => {
    const socket = tls.connect({ port, host: '127.0.0.1', servername: 'localhost', ca, minVersion: 'TLSv1.3' });
    const finish = ok => { clearTimeout(timer); socket.destroy(); resolveProbe(ok); };
    const timer = setTimeout(() => finish(false), 2500);
    socket.once('error', () => finish(false));
    socket.once('secureConnect', () => finish(socket.authorized));
  });
}

export class LinuxPeer {
  constructor(root, easytierPath, caBytes, serverUrl = null) {
    this.root = root;
    this.easytierPath = easytierPath;
    this.ca = caBytes;
    this.serverUrl = serverUrl;
    this.child = null;
    this.port = null;
    this.credential = undefined;
  }
  setServerUrl(url) {
    this.serverUrl = url ? normalizeServerUrl(url) : null;
  }
  async start(profile, deviceId, restart = false) {
    if (!restart && this.child && this.credential === profile.credential) return;
    await this.stop();
    this.port = await freePort();
    const trust = {
      server: {
        pubkey: profile.serverKey, groups: [], allow_relay: false, allowed_proxy_cidrs: [],
        reusable: false, created_at_unix: Math.floor(Date.now() / 1000), expiry_unix: Math.ceil(profile.expiresAt / 1000),
      },
    };
    writeAtomic(join(this.root, 'network-server.json'), JSON.stringify(trust));
    writeAtomic(join(this.root, 'network-session.toml'), sessionConfig(profile, deviceId, this.port, this.serverUrl));
    const keepProxy = process.env.ANYWHERE_MESH_USE_PROXY === '1';
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      !/^ET_/i.test(k) && (keepProxy || !/^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(k))));
    env.ET_CREDENTIAL = profile.credential;
    const child = spawn(this.easytierPath, [
      '--config-file', join(this.root, 'network-session.toml'),
      '--rpc-portal', '127.0.0.1:0',
      '--console-log-level', 'error',
    ], {
      cwd: this.root, env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    this.credential = profile.credential;
    let errTail = '';
    child.stderr.on('data', chunk => {
      errTail = (errTail + chunk.toString('utf8')).slice(-1024);
    });
    this.done = new Promise(r => {
      child.once('close', code => {
        if (code && this.child === child && errTail.trim()) {
          console.error('[linux-peer] easytier-core exited (' + code + '):', errTail.trim());
        }
        r(code);
      });
      child.once('error', err => console.error('[linux-peer] easytier-core error:', err.message));
    }).then(() => { if (this.child === child) this.child = null; });
  }
  async ready(waitMs = 25000) {
    const until = Date.now() + waitMs;
    do {
      if (!this.child) throw Error('LINUX_NETWORK_EXITED');
      if (await probeTls(this.port, this.ca)) return;
      await delay(300);
    } while (Date.now() < until);
    throw Error('LINUX_TUNNEL_NOT_READY');
  }
  async stop() {
    const child = this.child;
    this.child = null;
    this.credential = undefined;
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
      await Promise.race([this.done, delay(3000)]);
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}
