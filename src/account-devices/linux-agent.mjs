#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceClient, request } from './client.mjs';
import { linuxWorkspace } from './linux-workspace.mjs';
import { LinuxPeer } from './linux/network.mjs';
import { loadSavedServerUrl, normalizeServerUrl, readDefaultServerUrl, saveServerUrl } from './server-config.mjs';
import {
  DEFAULT_UPDATE_PUBLIC_KEY,
  MAX_BUNDLE_ARCHIVE_BYTES,
  MAX_FULL_ARTIFACT_BYTES,
  applyBundleUpdate,
  downloadVerified,
  fetchManifest,
  platformKeyFor,
  readInstalledMeta,
  resolveSafeArtifactUrl,
  selectUpdateArtifact,
} from '../desktop/updater-core.mjs';

function parseArgs(argv) {
  const opts = {
    url: process.env.ANYWHERE_MESH_URL || null,
    updateUrl: process.env.ANYWHERE_MESH_UPDATE_URL || null,
    state: process.env.ANYWHERE_MESH_STATE || join(homedir(), '.anywhere-mesh', 'linux-agent'),
    name: process.env.ANYWHERE_MESH_NAME || ('Linux · ' + hostname()),
    mode: process.env.ANYWHERE_MESH_MODE || 'read',
    projects: [],
    direct: false,
    checkUpdate: false,
    doUpdate: false,
    forceUpdate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') opts.url = argv[++i];
    else if (a === '--update-url') opts.updateUrl = argv[++i];
    else if (a === '--ca') opts.ca = resolve(argv[++i]);
    else if (a === '--easytier') opts.easytier = resolve(argv[++i]);
    else if (a === '--state') opts.state = resolve(argv[++i]);
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--username') opts.username = argv[++i];
    else if (a === '--password-file') opts.passwordFile = resolve(argv[++i]);
    else if (a === '--password-stdin') opts.passwordStdin = true;
    else if (a === '--logout') opts.logout = true;
    else if (a === '--direct') opts.direct = true;
    else if (a === '--check-update') opts.checkUpdate = true;
    else if (a === '--update') opts.doUpdate = true;
    else if (a === '--force') opts.forceUpdate = true;
    else if (a === '--project') {
      const p = realpathSync(resolve(argv[++i]));
      const label = argv[i + 1] === '--label' ? (i += 2, argv[i]) : basename(p);
      opts.projects.push({ path: p, label });
    } else if (a === '--help' || a === '-h') {
      console.log([
        'AnywhereMesh Linux Device Agent',
        '',
        'Usage:',
        '  anywhere-mesh-agent --url https://mesh.example.com --project /path/to/repo [--label my-repo] [--mode read|edit|execute]',
        '  anywhere-mesh-agent --check-update [--url https://mesh.example.com]',
        '  anywhere-mesh-agent --update [--url https://mesh.example.com] [--force]',
        '  anywhere-mesh-agent --logout',
        '',
        'Options:',
        '  --url <url>             Self-hosted server URL (e.g. https://mesh.example.com; remembered after first sign-in)',
        '  --update-url <url>      Override update manifest base URL',
        '  --ca <file>             Deployment CA certificate path',
        '  --easytier <file>       Path to easytier-core binary',
        '  --state <dir>           State directory (default: ~/.anywhere-mesh/linux-agent)',
        '  --name <name>           Device display name',
        '  --mode <mode>           Permission mode: read|edit|execute|revoked',
        '  --direct                Use direct HTTPS/WSS transport',
        '  --check-update          Check for signed client updates and print details',
        '  --update                Download, verify and apply available client update',
      ].join('\n'));
      process.exit(0);
    }
  }
  const appDir = resolve(import.meta.dirname, '../..');
  const savedUrl = loadSavedServerUrl(opts.state) || readDefaultServerUrl(appDir);
  if (opts.url) opts.url = normalizeServerUrl(opts.url, { allowHttpLocalhost: process.env.ANYWHERE_MESH_UPDATE_ALLOW_HTTP === '1' });
  else if (savedUrl) opts.url = savedUrl;
  if (opts.checkUpdate || opts.doUpdate) return opts;
  if (!opts.ca) throw Error('Missing required --ca /path/to/ca.crt');
  if (!opts.logout && !opts.url) throw Error('Missing required --url https://<your-server-domain> (or set ANYWHERE_MESH_URL)');
  if (!opts.logout && !opts.direct && !opts.easytier) throw Error('Missing required --easytier /path/to/easytier-core (or pass --direct)');
  if (!['revoked', 'read', 'edit', 'execute'].includes(opts.mode)) throw Error('Invalid --mode: ' + opts.mode);
  if (!opts.logout && !opts.projects.length) throw Error('At least one --project /path/to/dir is required');
  return opts;
}

function writeAtomic(file, content) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

class LinuxAgentClient extends DeviceClient {
  constructor(cfg, workspace, { serverUrl, peer, direct }) {
    super({ ...cfg, workspacePicker: true }, workspace);
    this.serverUrl = serverUrl;
    this.peer = peer;
    this.direct = direct;
    this.directMode = direct;
    this.tunnelTls = this.tls;
    this.publicTls = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
    this.tunnelReady = direct;
    this.networkToken = null;
    this.httpFailures = 0;
    this.probeFailures = 0;
  }
  bootstrap(route, data, token) {
    return request(this.serverUrl, { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      'POST', route, data, token, { idleMs: 15000, totalMs: 25000 });
  }
  async authenticate(params) {
    if (this.direct) return super.authenticate(params);
    return this.bootstrap('/api/auth/login', params);
  }
  remoteLogout(signed) {
    if (this.direct) return super.remoteLogout(signed);
    return this.bootstrap('/api/auth/logout', {}, signed.token);
  }
  connect(signed) {
    if (this.directMode || (this.peer?.child && this.tunnelReady)) super.connect(signed);
  }
  async ensureNetwork(signed) {
    if (this.direct) return;
    if ((!this.directMode && !this.peer.child) || this.networkToken !== signed.token || this.probeFailures >= 2) {
      console.log('[linux-agent] Negotiating transport with server...');
      const reqBody = process.env.ANYWHERE_MESH_TRANSPORT === 'easytier'
        ? { supportsDirect: true, prefer: 'easytier' }
        : { supportsDirect: true };
      const profile = await this.bootstrap('/api/device/network', reqBody, signed.token);
      if (profile?.transport === 'direct') {
        this.directMode = true;
        this.tls = this.publicTls;
        this.cfg.url = this.serverUrl;
        this.networkToken = signed.token;
        this.tunnelReady = true;
        this.probeFailures = 0;
        if (this.peer?.child) await this.peer.stop();
        console.log('[linux-agent] Using direct HTTPS/WSS transport (no EasyTier nesting).');
        return;
      }
      this.directMode = false;
      this.tls = this.tunnelTls;
      this.tunnelReady = false;
      await this.peer.start(profile, signed.deviceId, this.probeFailures >= 2);
      this.cfg.url = 'https://127.0.0.1:' + this.peer.port;
      this.networkToken = signed.token;
      this.probeFailures = 0;
      console.log('[linux-agent] EasyTier tunnel peer started on 127.0.0.1:' + this.peer.port + ', waiting for TLS handshake...');
    }
    if (this.directMode && this.networkToken === signed.token) {
      this.tunnelReady = true;
      return;
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

async function runCliUpdate(opts) {
  const appDir = resolve(import.meta.dirname, '../..');
  const installed = existsSync(resolve(appDir, '../tools/node'));
  const installDir = installed ? resolve(appDir, '../..') : null;
  const meta = readInstalledMeta(appDir);
  if (!meta.version) throw Error('Unable to read current client version from ' + join(appDir, 'package.json'));

  const baseUrl = (opts.updateUrl || opts.url || '').replace(/\/+$/, '');
  if (!baseUrl) throw Error('Missing server URL; pass --url https://<your-server-domain> or --update-url <url>');
  const publicKeyPem = process.env.ANYWHERE_MESH_UPDATE_PUBKEY || DEFAULT_UPDATE_PUBLIC_KEY;
  const allowHttpLocalhost = process.env.ANYWHERE_MESH_UPDATE_ALLOW_HTTP === '1';

  console.log(`[linux-agent] Checking updates from ${baseUrl} (current v${meta.version}, abi=${meta.runtimeAbi || 'none'})...`);
  const manifest = await fetchManifest(baseUrl, { publicKeyPem, allowHttpLocalhost });
  const decision = selectUpdateArtifact(manifest, {
    currentVersion: meta.version,
    platformKey: platformKeyFor(),
    runtimeAbi: meta.runtimeAbi,
    ignoreFailures: Boolean(opts.forceUpdate),
  });

  if (!decision.available) {
    if (decision.upToDate) {
      console.log(`[linux-agent] Already up to date (v${meta.version}).`);
      return;
    }
    throw Error(`Update v${decision.latestVersion} is not compatible with this installation (${decision.reason}).`);
  }

  const sizeKb = (decision.artifact.size / 1024).toFixed(1);
  console.log(`[linux-agent] Update available: v${meta.version} -> v${decision.version} (${decision.mode}, ${sizeKb} KiB)`);
  if (decision.notes) {
    console.log('\n--- Release Notes ---');
    console.log(decision.notes);
    console.log('---------------------\n');
  }

  if (!opts.doUpdate) {
    console.log('[linux-agent] Run with --update to download and install.');
    return;
  }

  if (!installed && process.env.ANYWHERE_MESH_UPDATE_ALLOW_DEV !== '1') {
    throw Error('Self-update is only supported for installed Linux packages (not source checkouts).');
  }

  const url = resolveSafeArtifactUrl(baseUrl, decision.artifact.url, { allowHttpLocalhost });
  const cacheDir = join(opts.state, 'updates');
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const safeName = basename(url.pathname).replace(/[^A-Za-z0-9._-]/g, '_');
  const destFile = join(cacheDir, safeName);

  let lastPct = -1;
  const dl = await downloadVerified(url, destFile, {
    expectedSha256: decision.artifact.sha256,
    expectedSize: decision.artifact.size,
    maxBytes: decision.mode === 'bundle' ? MAX_BUNDLE_ARCHIVE_BYTES : MAX_FULL_ARTIFACT_BYTES,
    allowHttpLocalhost,
    onProgress: p => {
      if (p.percent !== lastPct && (p.percent === 100 || p.percent - lastPct >= 10)) {
        lastPct = p.percent;
        console.log(`[linux-agent] Downloading: ${p.percent}% (${p.downloadedBytes}/${p.totalBytes} bytes)`);
      }
    },
  });
  console.log(`[linux-agent] Verified SHA-256: ${dl.sha256}`);

  if (decision.mode === 'bundle') {
    const applied = await applyBundleUpdate({
      archivePath: dl.path,
      expectedSha256: dl.sha256,
      targetVersion: decision.version,
      appDir,
      backupDir: appDir + '.prev',
      preserveRelPaths: [],
    });
    rmSync(dl.path, { force: true });
    console.log(`[linux-agent] Updated successfully to v${applied.version}. Restart any running agent service to use the new version.`);
  } else if (decision.mode === 'full' && decision.kind === 'linux-tar') {
    const extractDir = mkdtempSync(join(cacheDir, 'extract-'));
    try {
      execFileSync('tar', ['-xzf', dl.path, '-C', extractDir], { stdio: 'inherit', timeout: 120000 });
      const entries = readdirSync(extractDir);
      const topDir = entries.length === 1 ? join(extractDir, entries[0]) : extractDir;
      const installSh = join(topDir, 'install.sh');
      if (!existsSync(installSh)) throw Error('MISSING_LINUX_INSTALL_SH');
      const env = { ...process.env };
      if (installDir) env.ANYWHERE_MESH_INSTALL_DIR = installDir;
      execFileSync('bash', [installSh], { env, stdio: 'inherit', timeout: 120000 });
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
      rmSync(dl.path, { force: true });
    }
    console.log(`[linux-agent] Full package updated successfully to v${decision.version}. Restart any running agent service.`);
  } else {
    throw Error(`Unsupported update kind: ${decision.kind}`);
  }
}

async function notifyUpdateIfAvailable(opts) {
  try {
    const appDir = resolve(import.meta.dirname, '../..');
    const meta = readInstalledMeta(appDir);
    if (!meta.version) return;
    const baseUrl = (opts.updateUrl || opts.url || '').replace(/\/+$/, '');
    if (!baseUrl) return;
    const publicKeyPem = process.env.ANYWHERE_MESH_UPDATE_PUBKEY || DEFAULT_UPDATE_PUBLIC_KEY;
    const allowHttpLocalhost = process.env.ANYWHERE_MESH_UPDATE_ALLOW_HTTP === '1';
    const manifest = await fetchManifest(baseUrl, { publicKeyPem, allowHttpLocalhost, timeoutMs: 8000 });
    const decision = selectUpdateArtifact(manifest, {
      currentVersion: meta.version,
      platformKey: platformKeyFor(),
      runtimeAbi: meta.runtimeAbi,
    });
    if (decision.available) {
      console.log(`[linux-agent] Update available: v${meta.version} -> v${decision.version} (run 'anywhere-mesh-agent --update' to upgrade)`);
    }
  } catch {}
}

async function main() {
  process.umask(0o077);
  const opts = parseArgs(process.argv.slice(2));
  if (opts.checkUpdate || opts.doUpdate) {
    await runCliUpdate(opts);
    return;
  }
  mkdirSync(opts.state, { recursive: true, mode: 0o700 });
  if (opts.url) saveServerUrl(opts.state, opts.url);
  const caBytes = readFileSync(opts.ca);
  const peer = opts.direct ? null : new LinuxPeer(opts.state, opts.easytier, caBytes, opts.url);
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

  if (opts.logout) {
    await client.control('logout');
    console.log('[linux-agent] Signed out and cleared saved credentials.');
    return;
  }

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
  void notifyUpdateIfAvailable(opts);

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
