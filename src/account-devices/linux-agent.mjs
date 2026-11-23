#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceClient, request } from './client.mjs';
import { linuxWorkspace } from './linux-workspace.mjs';

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

function parseArgs(argv) {
  const opts = {
    url: 'https://awc.xbxbe.com',
    state: join(homedir(), '.anywhere-mesh', 'linux-agent'),
    name: 'Linux · ' + hostname(),
    mode: 'read',
    projects: [],
    direct: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') opts.url = argv[++i];
    else if (a === '--ca') opts.ca = resolve(argv[++i]);
    else if (a === '--easytier') opts.easytier = resolve(argv[++i]);
    else if (a === '--state') opts.state = resolve(argv[++i]);
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--username') opts.username = argv[++i];
    else if (a === '--password-file') opts.passwordFile = resolve(argv[++i]);
    else if (a === '--password-stdin') opts.passwordStdin = true;
    else if (a === '--direct') opts.direct = true;
    else if (a === '--project') {
      const p = realpathSync(resolve(argv[++i]));
      const label = argv[i + 1] === '--label' ? (i += 2, argv[i]) : basename(p);
      opts.projects.push({ path: p, label });
    } else if (a === '--help' || a === '-h') {
      console.log([
        'AnywhereMesh Linux Device Agent',
        '',
        'Usage:',
        '  node src/account-devices/linux-agent.mjs \\',
        '    --project /path/to/repo [--label my-repo] \\',
        '    --ca /path/to/ca.crt --easytier /path/to/easytier-core \\',
        '    [--url https://awc.xbxbe.com] [--state ~/.anywhere-mesh/linux-agent] \\',
        '    [--name "Linux · Host"] [--mode read|edit|execute|revoked] \\',
        '    [--username user --password-stdin|--password-file /path/pass]',
      ].join('\n'));
      process.exit(0);
    }
  }
  if (!opts.ca) throw Error('Missing required --ca /path/to/ca.crt');
  if (!opts.direct && !opts.easytier) throw Error('Missing required --easytier /path/to/easytier-core (or pass --direct)');
  if (!['revoked', 'read', 'edit', 'execute'].includes(opts.mode)) throw Error('Invalid --mode: ' + opts.mode);
  if (!opts.projects.length) throw Error('At least one --project /path/to/dir is required');
  return opts;
}

function sessionConfig(serverUrl, profile, deviceId, port) {
  const slot = /^10\.203\.73\.(\d{1,3})\/24$/.exec(profile.ipv4)?.[1];
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/.test(deviceId) ||
      !/^[\w-]{1,64}$/.test(profile.name) || !KEY_RE.test(profile.serverKey) || !KEY_RE.test(profile.credential) ||
      !Number.isSafeInteger(profile.expiresAt) || !slot || Number(slot) < 4 || Number(slot) > 254 ||
      !Number.isInteger(port) || port < 1 || port > 65535) throw Error('NETWORK_ENROLLMENT_UNAVAILABLE');
  const wsUri = serverUrl.replace(/^https:/i, 'wss:').replace(/\/+$/, '') + '/easytier';
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

class LinuxPeer {
  constructor(root, serverUrl, easytierPath, caBytes) {
    this.root = root; this.serverUrl = serverUrl; this.easytierPath = easytierPath; this.ca = caBytes;
    this.child = null; this.port = null; this.credential = undefined;
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
    writeAtomic(join(this.root, 'network-session.toml'), sessionConfig(this.serverUrl, profile, deviceId, this.port));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ET_/i.test(k)));
    env.ET_CREDENTIAL = profile.credential;
    const child = spawn(this.easytierPath, ['--config-file', join(this.root, 'network-session.toml')], {
      cwd: this.root, env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    this.credential = profile.credential;
    child.stderr.on('data', () => {});
    this.done = new Promise(r => { child.once('close', r); child.once('error', () => {}); })
      .then(() => { if (this.child === child) this.child = null; });
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
    const child = this.child; this.child = null; this.credential = undefined;
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
      await Promise.race([this.done, delay(3000)]);
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}

class LinuxAgentClient extends DeviceClient {
  constructor(cfg, workspace, { serverUrl, peer, direct }) {
    super({ ...cfg, workspacePicker: true }, workspace);
    this.serverUrl = serverUrl;
    this.peer = peer;
    this.direct = direct;
    this.tunnelReady = direct;
    this.networkToken = null;
    this.httpFailures = 0;
    this.probeFailures = 0;
  }
  bootstrap(route, data, token) {
    return request(this.serverUrl, { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      'POST', route, data, token, { idleMs: 15000, totalMs: 20000 });
  }
  async authenticate(params) {
    if (this.direct) return super.authenticate(params);
    return this.bootstrap('/api/auth/login', params);
  }
  connect(signed) {
    if (this.direct || (this.peer.child && this.tunnelReady)) super.connect(signed);
  }
  async ensureNetwork(signed) {
    if (this.direct) return;
    if (!this.peer.child || this.networkToken !== signed.token || this.probeFailures >= 2) {
      console.log('[linux-agent] Enrolling encrypted EasyTier tunnel...');
      const profile = await this.bootstrap('/api/device/network', {}, signed.token);
      this.tunnelReady = false;
      await this.peer.start(profile, signed.deviceId, this.probeFailures >= 2);
      this.cfg.url = 'https://127.0.0.1:' + this.peer.port;
      this.networkToken = signed.token;
      this.probeFailures = 0;
      console.log('[linux-agent] Tunnel peer started on 127.0.0.1:' + this.peer.port + ', waiting for TLS handshake...');
    }
    if (this.tunnelReady) return;
    try {
      await this.peer.ready(25000);
      this.tunnelReady = true;
      this.probeFailures = 0;
      console.log('[linux-agent] Encrypted tunnel ready.');
    } catch (err) {
      this.probeFailures++;
      throw err;
    }
  }
  async verifiedState(saved) {
    await this.ensureNetwork(saved);
    try {
      const st = await super.verifiedState(saved);
      this.httpFailures = 0;
      return st;
    } catch (err) {
      if (!['LOGIN_REQUIRED', 'DEVICE_DISABLED'].includes(err.message) && ++this.httpFailures >= 2) {
        this.tunnelReady = false;
      }
      throw err;
    }
  }
  async currentState() {
    const signed = this.signed;
    const st = await this.verifiedState(signed);
    if (st.user?.id !== signed.user.id || st.deviceId !== signed.deviceId) throw Error('LOGIN_BINDING_MISMATCH');
    this.connect(signed);
    return st;
  }
  async syncProjects(desiredProjects, desiredMode) {
    for (const p of desiredProjects) {
      const inode = this.identifyRoot(p.path);
      let root = this.profile.projects.find(x => x.path === p.path);
      if (root && root.inode !== inode) {
        root.inode = inode;
      }
      if (!root) {
        root = { path: p.path, inode, localId: randomUUID(), label: p.label };
        this.profile.projects.push(root);
        writeAtomic(this.profile.file, JSON.stringify({ secret: this.profile.secret, projects: this.profile.projects }));
      }
      const mapped = await this.api('POST', '/api/device/workspaces', { localId: root.localId, label: p.label });
      const existing = this.locals.get(mapped.id);
      const local = existing ?? this.attachProject(this.signed, root, mapped, false);
      local.available = true;
      if (!local.rpc) this.connectProject(this.signed, this.presence, local);
      if (local.agent.grant.mode !== desiredMode) {
        this.setMode(local, desiredMode);
      }
      console.log(`[linux-agent] Bound project "${p.label}" (${p.path}) -> id=${mapped.id} mode=${local.agent.grant.mode}`);
    }
  }
  async stopAll() {
    try { await this.suspend(); } finally { await this.peer?.stop(); }
  }
}

async function readPassword(opts) {
  if (opts.passwordFile) return readFileSync(opts.passwordFile, 'utf8').trim();
  if (opts.passwordStdin) {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    return raw.trim();
  }
  throw Error('No saved login found; pass --username <user> with --password-stdin or --password-file');
}

async function main() {
  process.umask(0o077);
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(opts.state, { recursive: true, mode: 0o700 });
  const caBytes = readFileSync(opts.ca);
  const peer = opts.direct ? null : new LinuxPeer(opts.state, opts.url, opts.easytier, caBytes);
  const ws = linuxWorkspace();
  const client = new LinuxAgentClient(
    { name: opts.name, url: opts.url, ca: opts.ca, stateDir: opts.state, projects: opts.projects },
    ws,
    { serverUrl: opts.url, peer, direct: opts.direct },
  );

  let closing = false;
  const shutdown = async sig => {
    if (closing) return;
    closing = true;
    console.log(`[linux-agent] Received ${sig}, shutting down cleanly...`);
    await client.stopAll().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Restore saved login or authenticate fresh
  let state = await client.control('state');
  if (!state.user && !state.restoring) {
    if (!opts.username) throw Error('No saved login found; provide --username and --password-stdin/--password-file');
    const password = await readPassword(opts);
    console.log(`[linux-agent] Signing in as ${opts.username} (${opts.name})...`);
    await client.control('login', { username: opts.username, password });
  }

  // Wait for tunnel + state sync
  for (let attempt = 1; ; attempt++) {
    try {
      state = await client.control('state');
      if (state.user) break;
    } catch (err) {
      console.error(`[linux-agent] State sync attempt ${attempt} failed: ${err.message}`);
    }
    await delay(2000);
  }
  console.log(`[linux-agent] Signed in as ${state.user.username}, deviceId=${state.deviceId}`);
  await client.syncProjects(opts.projects, opts.mode);

  // Wait until projects report ready on server
  for (let i = 0; i < 30; i++) {
    const st = await client.control('state');
    const mine = st.projects.filter(p => p.deviceId === st.deviceId);
    if (mine.length >= opts.projects.length && mine.every(p => p.ready && p.mode === opts.mode)) {
      console.log(`[linux-agent] ONLINE & READY: ${mine.map(p => `${p.label}(${p.mode})`).join(', ')}`);
      break;
    }
    await delay(500);
  }

  // Keep tunnel & project connections healthy
  setInterval(async () => {
    if (closing) return;
    try {
      const st = await client.control('state');
      if (!st.user) {
        console.error('[linux-agent] Session expired or revoked; exiting.');
        await shutdown('EXPIRED');
      }
    } catch (err) {
      console.error('[linux-agent] Health sync retry:', err.message);
    }
  }, 15000);
}

main().catch(err => {
  console.error('[linux-agent] Fatal:', err.message);
  process.exit(1);
});
