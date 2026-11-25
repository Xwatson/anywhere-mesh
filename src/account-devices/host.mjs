import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import https from 'node:https';
import { WebSocketServer } from '../execution/node_modules/ws/wrapper.mjs';
import { Broker } from '../execution/broker.mjs';
import { Journal } from '../execution/journal.mjs';
import { Rpc } from '../execution/rpc.mjs';
import { serveControl } from '../execution/control.mjs';
import { grantFor } from '../execution/grants.mjs';
import { TERMINAL } from '../execution/protocol.mjs';
import { SessionHost } from '../session-host/runtime.mjs';
import { TurnLaunchLimiter } from '../session-host/launch-limiter.mjs';
import { fields, uuid } from '../session-host/store.mjs';
import { register } from '../desktop-commander/adapter.mjs';
import { CAPABILITIES } from '../execution/protocol.mjs';
import { NetworkLeases } from './network-leases.mjs';
import * as directory from './directory.mjs';
import pkg from '../../package.json' with { type: 'json' };

const appVersion = typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null;

if (!CAPABILITIES.includes('dc.tool.v1')) register();
for (const c of ['workspace.grants.v1', 'history.archive.v1', 'review.v1']) if (!CAPABILITIES.includes(c)) CAPABILITIES.push(c);

export async function startServer(config) {
  const network = config.windowsNetwork ? new NetworkLeases(config.windowsNetwork) : null;
  const CodexTurns = config.codexSocket ? (await import('../session-host/codex-turns.mjs')).CodexTurns : null;
  const AntigravityTurns = config.antigravitySocket ? (await import('../session-host/antigravity-turns.mjs')).AntigravityTurns : null;
  const accounts = new Map(), projects = new Map(), opening = new Map(), online = new Map(), streams = new Set();
  const launchLimiter = new TurnLaunchLimiter(config.launchLimiter);
  const workspaceLocks = new Map();
  let quotaCache = null, quotaCacheAt = 0, quotaInFlight = null;
  const socketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 524288 });
  function account(id) {
    if (!accounts.has(id)) {
      const stateDir = join(config.stateDir, 'u' + id);
      const host = new SessionHost({
        stateDir, accountId: String(id), requireDeviceBinding: true, workspaces: [],
        mcpPath: config.mcpPath, launchLimiter, workspaceLocks,
      });
      if (CodexTurns) host.codex = new CodexTurns(host, config.codexSocket, config.codexCwd);
      if (AntigravityTurns) host.antigravity = new AntigravityTurns(host, config.antigravitySocket, config.antigravityCwd, {
        bridgePath: config.antigravityMcpBridge,
        nodePath: config.nodePath,
        mcpDir: config.antigravityMcpDir,
      });
      accounts.set(id, host);
    }
    return accounts.get(id);
  }
  async function openProject(id, project) {
    const host = account(id);
    if (projects.has(project.id)) { host.workspaces.get(project.id).label = project.label; return; }
    if (opening.has(project.id)) return opening.get(project.id);
    const grant = grantFor({ deviceId: project.deviceId, accountId: String(id), workspaceId: project.id }, 'revoked', 1);
    const w = { ...project, brokerDir: join(host.config.stateDir, project.id), grant };
    const task = (async () => {
      mkdirSync(w.brokerDir, { recursive: true, mode: 0o700 });
      const store = new Journal(join(w.brokerDir, 'journal.sqlite'));
      const broker = new Broker(store, grant, { workspace: { label: w.label, reliability: true } });
      try {
        const control = await serveControl(join(w.brokerDir, 'control.sock'), broker);
        projects.set(w.id, { broker, store, control });
        host.workspaces.set(w.id, w);
      } catch (e) { broker.close(); store.close(); throw e; }
    })();
    opening.set(w.id, task);
    try { await task; } finally { opening.delete(w.id); }
  }
  function closeProject(userId, workspaceId, { force = false } = {}) {
    const entry = projects.get(workspaceId);
    if (entry) {
      if (!force && entry.broker.journal.all('ops').some(o => !TERMINAL.has(o.state))) throw Error('WORKSPACE_NOT_READY');
      entry.broker.close(); entry.control.close(); entry.store.close();
      projects.delete(workspaceId);
    }
    accounts.get(userId)?.workspaces.delete(workspaceId);
  }
  async function prepare(id) {
    const host = account(id);
    for (const p of directory.workspaces(id)) await openProject(id, p);
    if (!host.timer) host.start();
    return host;
  }
  for (const userId of directory.accountIds()) await prepare(userId);

  async function readQuota(host, force = false) {
    const now = Date.now();
    const ttl = force ? 5000 : 60000;
    if (quotaCache && now - quotaCacheAt < ttl) return quotaCache;
    if (quotaInFlight) return quotaInFlight;
    quotaInFlight = (async () => {
      const tasks = [];
      if (host.codex) tasks.push(host.codex.readQuota());
      if (host.antigravity) tasks.push(host.antigravity.readQuota());
      const engines = tasks.length ? await Promise.all(tasks) : [];
      const snapshot = { fetchedAt: Date.now(), engines };
      const hasOk = engines.some(e => e.status === 'ok');
      quotaCache = snapshot;
      quotaCacheAt = hasOk || !engines.length ? snapshot.fetchedAt : snapshot.fetchedAt - 50000;
      return snapshot;
    })().finally(() => { quotaInFlight = null; });
    return quotaInFlight;
  }

  function detach(id, current = online.get(id)) {
    if (!current || online.get(id) !== current) return;
    online.delete(id);
    for (const ws of current.tools) ws.terminate();
    current.socket.terminate();
    // Use the last authenticated heartbeat, including when a silent link times out.
    directory.seen(id, current.lastSeen);
  }
  function deviceRows(id) {
    return directory.devices(id).map(d => ({ ...d, disabled: Boolean(d.disabled), online: online.has(d.id),
      lastSeen: online.get(d.id)?.lastSeen ?? d.lastSeen }));
  }
  function workspaceRows(userId, thisDevice) {
    return directory.workspaces(userId).map(p => {
      const broker = projects.get(p.id)?.broker;
      const unknownOps = broker?.workspaceStatus?.unknownOperations ?? [];
      return {
        id: p.id, label: p.label, deviceId: p.deviceId,
        ready: online.has(p.deviceId) && broker?.phase === 'ready',
        mode: broker?.grant.mode ?? 'revoked',
        unknownCount: unknownOps.length,
        ...(p.deviceId === thisDevice ? { localId: p.localId } : {}),
      };
    });
  }
  const cookieName = 'anywhere_device_session';
  function credential(req) {
    const header = req.headers.authorization;
    return header ? header.replace(/^Bearer /, '') :
      (req.headers.cookie ?? '').split(';').map(p => p.trim()).find(p => p.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  async function rawBody(req, limit = 262144) {
    const parts = []; let bytes = 0;
    for await (const part of req) {
      bytes += part.length; if (bytes > limit) throw Error('BODY_LIMIT'); parts.push(part);
    }
    return Buffer.concat(parts);
  }
  async function body(req, limit = 262144) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw Error('INVALID_FIELDS');
    const raw = await rawBody(req, limit);
    try { return JSON.parse(raw); } catch { throw Error('INVALID_FIELDS'); }
  }
  const assets = new Map([
    ['/', ['index.html', 'text/html']],
    ['/app.js', ['app.js', 'text/javascript']],
    ['/thread.js', ['thread.js', 'text/javascript']],
    ['/session-cache.js', ['session-cache.js', 'text/javascript']],
    ['/style.css', ['style.css', 'text/css']],
    ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
    ['/sw.js', ['sw.js', 'text/javascript']],
    ['/icon-192.png', ['icon-192.png', 'image/png']],
    ['/icon-512.png', ['icon-512.png', 'image/png']],
    ['/apple-touch-icon.png', ['icon-192.png', 'image/png']],
  ]);
  const uiVersion = (() => {
    const h = createHash('sha256');
    for (const [name] of assets.values()) {
      try { h.update(readFileSync(new URL('./ui/' + name, import.meta.url))); } catch {}
    }
    return h.digest('hex').slice(0, 12);
  })();
  const updatesDir = config.updatesDir || (config.stateDir ? join(config.stateDir, 'updates') : null);
  const UPDATE_FILE_RE = /^\/updates\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
  const UPDATE_EXT_RE = /(?:\.json|\.tar\.gz|\.exe|\.zip|\.sha256)$/i;
  function serveUpdateFile(req, res, filename) {
    if (!updatesDir || !UPDATE_EXT_RE.test(filename) || filename.includes('..')) {
      json(res, 404, { error: 'UPDATE_NOT_AVAILABLE' });
      return;
    }
    let rootReal, targetReal;
    try {
      if (!existsSync(updatesDir)) { json(res, 404, { error: 'UPDATE_NOT_AVAILABLE' }); return; }
      rootReal = realpathSync(resolve(updatesDir));
      targetReal = realpathSync(resolve(rootReal, filename));
    } catch {
      json(res, 404, { error: 'UPDATE_NOT_AVAILABLE' });
      return;
    }
    if (!targetReal.startsWith(rootReal + sep)) {
      json(res, 403, { error: 'FORBIDDEN' });
      return;
    }
    let st;
    try { st = statSync(targetReal); } catch { json(res, 404, { error: 'UPDATE_NOT_AVAILABLE' }); return; }
    if (!st.isFile()) { json(res, 404, { error: 'UPDATE_NOT_AVAILABLE' }); return; }

    const isManifest = filename === 'manifest.json';
    const contentType = filename.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : filename.endsWith('.sha256')
        ? 'text/plain; charset=utf-8'
        : filename.endsWith('.tar.gz')
          ? 'application/gzip'
          : 'application/octet-stream';
    const cacheControl = isManifest ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable';
    const baseHeaders = {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'Accept-Ranges': 'bytes',
    };
    if (!isManifest) {
      baseHeaders['Content-Disposition'] = `attachment; filename="${filename}"`;
    }
    req.setTimeout?.(0);
    res.setTimeout?.(0);

    const rangeHeader = req.headers.range;
    if (!isManifest && typeof rangeHeader === 'string' && /^bytes=\d*-\d*$/i.test(rangeHeader.trim())) {
      const [startStr, endStr] = rangeHeader.trim().slice(6).split('-');
      let start, end;
      if (startStr === '' && endStr !== '') {
        const suffix = Number(endStr);
        start = Math.max(0, st.size - suffix);
        end = st.size - 1;
      } else {
        start = Number(startStr);
        end = endStr === '' ? st.size - 1 : Math.min(st.size - 1, Number(endStr));
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= st.size) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      const chunkLen = end - start + 1;
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': String(chunkLen),
      });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(targetReal, { start, end });
      stream.on('error', () => { if (!res.destroyed) res.destroy(); });
      stream.pipe(res);
      return;
    }

    res.writeHead(200, { ...baseHeaders, 'Content-Length': String(st.size) });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(targetReal);
    stream.on('error', () => { if (!res.destroyed) res.destroy(); });
    stream.pipe(res);
  }
  async function handle(req, res) {
    const url = new URL(req.url, 'https://local.invalid'), path = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.origin && req.headers.origin !== 'https://' + req.headers.host) throw Error('FORBIDDEN');
    const updateMatch = (req.method === 'GET' || req.method === 'HEAD') && UPDATE_FILE_RE.exec(path);
    if (updateMatch) {
      serveUpdateFile(req, res, updateMatch[1]);
      return;
    }
    if (req.method === 'GET' && assets.has(path)) {
      const [name, type] = assets.get(path);
      const contentType = type.startsWith('text/') || type.includes('json') ? type + '; charset=utf-8' : type;
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      res.end(readFileSync(new URL('./ui/' + name, import.meta.url))); return;
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      const signed = directory.login(await body(req), req.socket.remoteAddress);
      if (signed.deviceId) {
        detach(signed.deviceId);
        await prepare(signed.user.id);
      } else {
        res.setHeader('Set-Cookie', cookieName + '=' + signed.token + '; Path=/; HttpOnly; SameSite=Strict; Secure');
      }
      json(res, 200, { user: signed.user, deviceId: signed.deviceId, ...(signed.deviceId ? { token: signed.token,
        projects: directory.workspaces(signed.user.id).filter(p => p.deviceId === signed.deviceId) } : {}) }); return;
    }
    const token = credential(req), { user, deviceId } = directory.authenticate(token);
    if (req.method === 'POST' && path === '/api/device/network') {
      if (!deviceId || !req.headers.authorization?.startsWith('Bearer ')) throw Error('FORBIDDEN');
      const input = await body(req);
      fields(input, [], ['supportsDirect', 'prefer']);
      if (config.directTransport && input.supportsDirect === true && input.prefer !== 'easytier') {
        json(res, 200, { transport: 'direct' }); return;
      }
      if (!network) throw Error('NETWORK_ENROLLMENT_UNAVAILABLE');
      json(res, 200, { transport: 'easytier', ...(await network.issue(token)) }); return;
    }
    if (req.method === 'POST' && path === '/api/device/workspaces') {
      if (!deviceId || !req.headers.authorization?.startsWith('Bearer ')) throw Error('FORBIDDEN');
      const project = directory.registerWorkspace(token, await body(req));
      await openProject(user.id, project);
      json(res, 200, project); return;
    }
    const delWs = path.match(/^\/api\/device\/workspaces\/([a-f0-9-]{36})$/);
    if (delWs && req.method === 'DELETE') {
      if (!deviceId || !req.headers.authorization?.startsWith('Bearer ')) throw Error('FORBIDDEN');
      const host = account(user.id);
      if (host.sessions().some(s => s.workspaceId === delWs[1] && s.activeTurn)) throw Error('WORKSPACE_NOT_READY');
      closeProject(user.id, delWs[1]);
      host.purgeWorkspaceMemories(delWs[1]);
      json(res, 200, directory.removeWorkspace(token, delWs[1])); return;
    }
    if (req.method === 'POST' && path === '/api/auth/password') {
      const userId = directory.changePassword(token, await body(req));
      for (const [id, peer] of online) {
        if (peer.userId === userId && peer.token !== token) detach(id, peer);
      }
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && path === '/api/auth/logout') {
      fields(await body(req), []); directory.logout(token); if (online.get(deviceId)?.token === token) detach(deviceId);
      res.setHeader('Set-Cookie', cookieName + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure');
      json(res, 200, { ok: true }); return;
    }
    if (path.startsWith('/api/admin/')) {
      if (!user.isAdmin) throw Error('FORBIDDEN');
      if (req.method === 'GET' && path === '/api/admin/devices') {
        const rows = deviceRows().map(d => ({ ...d, sessions: account(d.userId).sessions().filter(s => s.deviceId === d.id)
          .map(s => ({ id: s.id, title: s.title })) }));
        json(res, 200, rows); return;
      }
      if (req.method === 'POST' && path === '/api/admin/devices/prune') {
        fields(await body(req), []);
        const candidates = deviceRows().filter(d => !d.online && account(d.userId).sessions().every(s => s.deviceId !== d.id));
        let removed = 0;
        for (const d of candidates) {
          try {
            const deleted = directory.deleteDevice(d.id);
            const acc = account(deleted.userId);
            for (const wid of deleted.workspaceIds) {
              closeProject(deleted.userId, wid, { force: true });
              acc.purgeWorkspaceMemories(wid);
            }
            removed++;
          } catch {}
        }
        json(res, 200, { ok: true, removed }); return;
      }
      const target = path.match(/^\/api\/admin\/devices\/([a-f0-9-]{36})$/);
      if (target && req.method === 'POST') {
        const b = await body(req); fields(b, ['disabled']); directory.setDisabled(target[1], b.disabled);
        if (b.disabled) detach(target[1]); json(res, 200, { ok: true }); return;
      }
      if (target && req.method === 'DELETE') {
        const info = directory.deviceInfo(target[1]);
        if (account(info.userId).sessions().some(s => s.deviceId === info.id && s.activeTurn)) throw Error('DEVICE_BUSY');
        detach(info.id);
        const deleted = directory.deleteDevice(info.id);
        const acc = account(deleted.userId);
        for (const wid of deleted.workspaceIds) {
          closeProject(deleted.userId, wid, { force: true });
          acc.purgeWorkspaceMemories(wid);
        }
        json(res, 200, { ok: true, id: info.id }); return;
      }
      if (req.method === 'GET' && path === '/api/admin/users') {
        const onlineByUser = new Map();
        for (const p of online.values()) onlineByUser.set(p.userId, (onlineByUser.get(p.userId) ?? 0) + 1);
        const users = directory.listUsers().map(u => ({ ...u, onlineDevices: onlineByUser.get(u.id) ?? 0 }));
        json(res, 200, users); return;
      }
      if (req.method === 'POST' && path === '/api/admin/users') {
        const created = directory.createUserAccount(await body(req));
        json(res, 200, { ...created, onlineDevices: 0 }); return;
      }
      const userPass = path.match(/^\/api\/admin\/users\/(\d+)\/password$/);
      if (userPass && req.method === 'POST') {
        const b = await body(req); fields(b, ['password']);
        const uid = Number(userPass[1]);
        directory.resetUserPassword(uid, b.password);
        for (const [id, peer] of online) {
          if (peer.userId === uid) detach(id, peer);
        }
        json(res, 200, { ok: true }); return;
      }
      const userRole = path.match(/^\/api\/admin\/users\/(\d+)\/role$/);
      if (userRole && req.method === 'POST') {
        const b = await body(req); fields(b, ['isAdmin']);
        const updated = directory.setUserAdmin(user.id, Number(userRole[1]), b.isAdmin);
        json(res, 200, updated); return;
      }
      const userDel = path.match(/^\/api\/admin\/users\/(\d+)$/);
      if (userDel && req.method === 'DELETE') {
        const uid = Number(userDel[1]);
        if (accounts.get(uid)?.sessions().some(s => s.activeTurn)) throw Error('DEVICE_BUSY');
        const deleted = directory.deleteUserAccount(user.id, uid);
        for (const devId of deleted.deviceIds) detach(devId);
        for (const wid of deleted.workspaceIds) closeProject(uid, wid, { force: true });
        const accHost = accounts.get(uid);
        if (accHost) {
          try { accHost.store.db.exec('DELETE FROM memories'); } catch {}
          accounts.delete(uid);
          await accHost.close();
        }
        json(res, 200, { ok: true, id: uid }); return;
      }
      throw Error('NOT_FOUND');
    }
    const host = account(user.id);
    if (req.method === 'GET' && path === '/api/state') {
      const engines = [];
      if (host.codex) engines.push('codex');
      if (host.antigravity) engines.push('antigravity');
      const [codexModels, agyModels] = await Promise.all([
        host.codex ? host.codex.listModels().catch(() => null) : null,
        host.antigravity ? host.antigravity.listModels().catch(() => null) : null,
      ]);
      const engineModels = {};
      if (codexModels?.models) engineModels.codex = codexModels.models;
      if (agyModels?.models) engineModels.antigravity = agyModels.models;
      const fallbackModels = codexModels?.models ?? agyModels?.models ?? null;
      json(res, 200, {
        user, deviceId, uiVersion,
        ...(appVersion ? { appVersion } : {}),
        chatEngine: engines[0] ?? 'mock',
        engines,
        ...(fallbackModels ? { models: fallbackModels } : {}),
        ...(Object.keys(engineModels).length ? { engineModels } : {}),
        devices: deviceRows(user.id), projects: workspaceRows(user.id, deviceId), sessions: host.sessions(),
      }); return;
    }
    if (req.method === 'GET' && path === '/api/quota') {
      json(res, 200, await readQuota(host, url.searchParams.get('refresh') === '1')); return;
    }
    if (path === '/api/memories') {
      if (req.method === 'GET') {
        const scope = url.searchParams.get('scope') ?? 'workspace';
        const workspaceId = url.searchParams.get('workspaceId') || null;
        json(res, 200, host.listMemories(scope, workspaceId)); return;
      }
      if (req.method === 'PUT') {
        const b = await body(req);
        fields(b, ['scope', 'key', 'content'], ['workspaceId']);
        const workspaceId = b.scope === 'workspace' ? b.workspaceId : null;
        if (b.scope === 'user' && b.workspaceId !== undefined && b.workspaceId !== null) throw Error('INVALID_FIELDS');
        json(res, 200, host.saveMemory(b.scope, workspaceId, { key: b.key, content: b.content })); return;
      }
      if (req.method === 'DELETE') {
        const scope = url.searchParams.get('scope') ?? 'workspace';
        const workspaceId = url.searchParams.get('workspaceId') || null;
        if (url.searchParams.get('all') === '1') {
          json(res, 200, host.clearMemories(scope, workspaceId)); return;
        }
        const key = url.searchParams.get('key') ?? '';
        json(res, 200, host.deleteMemory(scope, workspaceId, key)); return;
      }
    }
    if (req.method === 'POST' && path === '/api/sessions') {
      const input = await body(req); fields(input, ['workspaceId', 'title', 'requestId'], ['options']);
      const w = host.workspace(input.workspaceId);
      const isOwnDevice = Boolean(deviceId && w.grant.deviceId === deviceId);
      if (!isOwnDevice) {
        const broker = projects.get(w.id)?.broker;
        if (!online.has(w.grant.deviceId)) throw Error('DEVICE_OFFLINE');
        if (!broker || broker.phase !== 'ready' || broker.grant.mode === 'revoked') throw Error('LOCAL_PERMISSION_REQUIRED');
      }
      json(res, 200, host.create(input)); return;
    }
    const sessionOnly = path.match(/^\/api\/sessions\/([a-f0-9-]{36})$/);
    if (sessionOnly) {
      if (req.method === 'PATCH') {
        const b = await body(req); fields(b, [], ['title', 'options']);
        let updated = host.session(sessionOnly[1]);
        if ('title' in b) updated = host.renameSession(sessionOnly[1], b.title);
        if ('options' in b) updated = host.updateSessionOptions(sessionOnly[1], b.options);
        json(res, 200, updated); return;
      }
      if (req.method === 'DELETE') {
        json(res, 200, await host.deleteSession(sessionOnly[1])); return;
      }
    }
    const attGet = path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/attachments\/([a-f0-9-]{36})$/);
    if (attGet && req.method === 'GET') {
      host.session(attGet[1]);
      const { att, bytes } = await host.readAttachmentBytes(attGet[1], attGet[2]);
      res.writeHead(200, {
        'Content-Type': att.mime,
        'Content-Length': bytes.length,
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(att.name)}`,
      });
      res.end(bytes); return;
    }
    const match = path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/(events|messages|stop|stream|attachments|compact)$/);
    if (!match) throw Error('NOT_FOUND');
    const s = host.session(match[1]);
    if (req.method === 'GET' && match[2] === 'events') {
      if (url.searchParams.has('beforeSeq')) {
        json(res, 200, host.store.pageBefore(s.id, Number(url.searchParams.get('beforeSeq')))); return;
      }
      json(res, 200, host.store.page(s.id, Number(url.searchParams.get('afterSeq') ?? 0))); return;
    }
    if (req.method === 'GET' && match[2] === 'stream') {
      let cursor = Number(url.searchParams.get('afterSeq') ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error('INVALID_CURSOR');
      req.setTimeout(0); res.setTimeout(0);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const writeEvent = (name, data) => {
        if (!res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const flushEvents = () => {
        try {
          const cur = host.session(s.id);
          if (cursor > cur.lastSeq) cursor = 0;
          let safety = 0;
          while (cursor < cur.lastSeq && safety++ < 20) {
            const page = host.store.page(s.id, cursor);
            writeEvent('events', page);
            cursor = page.throughSeq;
            if (!page.more) break;
          }
        } catch {}
      };
      const onEvents = sid => { if (sid === s.id) flushEvents(); };
      const onDelta = (sid, delta) => { if (sid === s.id) writeEvent('delta', { sessionId: s.id, delta }); };
      host.on('events', onEvents);
      host.on('delta', onDelta);
      const ping = setInterval(() => {
        try {
          directory.authenticate(token);
          if (!res.writableEnded) res.write(': ping\n\n');
        } catch { closeStream(); }
      }, 15000);
      const closeStream = () => {
        clearInterval(ping);
        host.off('events', onEvents);
        host.off('delta', onDelta);
        streams.delete(closeStream);
        if (!res.writableEnded) res.end();
      };
      streams.add(closeStream);
      req.on('close', closeStream);
      flushEvents();
      return;
    }
    if (req.method === 'POST' && match[2] === 'attachments') {
      const ct = req.headers['content-type'] ?? '';
      let name, mime, bytes;
      if (!req.headers['x-filename'] && /^application\/json(?:\s*;|$)/i.test(ct)) {
        const b = await body(req, 15 * 1024 * 1024);
        fields(b, ['name', 'mime', 'dataBase64']);
        name = b.name; mime = b.mime; bytes = Buffer.from(String(b.dataBase64), 'base64');
      } else {
        name = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
        mime = ct || 'application/octet-stream';
        bytes = await rawBody(req, 20 * 1024 * 1024);
      }
      json(res, 200, await host.saveAttachment(s.id, { name, mime, bytes })); return;
    }
    if (req.method === 'POST' && match[2] === 'messages') {
      const b = await body(req); fields(b, ['requestId', 'text'], ['attachments']);
      const prior = host.store.request(b.requestId, { kind: 'send', sessionId: s.id, text: b.text, ...(b.attachments?.length ? { attachments: b.attachments } : {}) });
      if (!prior && !online.has(s.deviceId)) throw Error('DEVICE_OFFLINE');
      json(res, 200, prior ?? await host.send(s.id, b)); return;
    }
    if (req.method === 'POST' && match[2] === 'stop') { json(res, 200, await host.stop(s.id, await body(req))); return; }
    if (req.method === 'POST' && match[2] === 'compact') { json(res, 200, await host.compactSession(s.id)); return; }
    throw Error('NOT_FOUND');
  }
  const server = https.createServer({ cert: readFileSync(config.cert), key: readFileSync(config.key), minVersion: 'TLSv1.3' }, (req, res) => {
    handle(req, res).catch(e => {
      const message = e.code ?? e.message;
      const status = { LOGIN_REQUIRED: 401, INVALID_CREDENTIALS: 401, FORBIDDEN: 403, DEVICE_DISABLED: 403, CREATE_ON_THIS_DEVICE: 403,
        NETWORK_ENROLLMENT_UNAVAILABLE: 503, NETWORK_ADDRESS_LIMIT: 503, NOT_FOUND: 404, SESSION_NOT_FOUND: 404, ATTACHMENT_NOT_FOUND: 404,
        LOGIN_THROTTLED: 429, PASSWORD_THROTTLED: 429, INVALID_FIELDS: 400, INVALID_ID: 400, INVALID_TEXT: 400, INVALID_USERNAME: 400,
        INVALID_MEMORY_SCOPE: 400, MEMORY_TOO_LARGE: 400, MEMORY_LIMIT_REACHED: 409, MEMORY_STORAGE_LIMIT: 409,
        INVALID_ATTACHMENT: 400, BODY_LIMIT: 413, USERNAME_TAKEN: 409, LAST_ADMIN_PROTECTED: 400, CANNOT_DELETE_SELF: 400, DEVICE_BUSY: 409,
        INCORRECT_CURRENT_PASSWORD: 400, INVALID_NEW_PASSWORD: 400, PASSWORD_UNCHANGED: 400 }[message] ?? 409;
      if (!res.headersSent) json(res, status, { error: /^[A-Z0-9_]+$/.test(message) ? message : 'REQUEST_FAILED' });
    });
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.headers.origin || !req.headers.authorization?.startsWith('Bearer ')) throw Error('FORBIDDEN');
      const token = credential(req), { user, deviceId } = directory.authenticate(token);
      if (!deviceId) throw Error('FORBIDDEN');
      if (req.url === '/ws/device') {
        socketServer.handleUpgrade(req, socket, head, ws => {
          ws._socket?.setKeepAlive?.(true, 15000);
          detach(deviceId);
          const current = { socket: ws, token, userId: user.id, lastSeen: Date.now(), saved: Date.now(), tools: new Set() };
          online.set(deviceId, current); directory.seen(deviceId);
          ws.on('pong', () => {
            if (online.get(deviceId) !== current) return;
            current.lastSeen = Date.now();
            if (current.lastSeen - current.saved >= 60000) { directory.seen(deviceId, current.lastSeen); current.saved = current.lastSeen; }
          });
          ws.on('message', () => ws.close(1008));
          ws.on('close', () => detach(deviceId, current)); ws.on('error', () => {});
        }); return;
      }
      const m = req.url?.match(/^\/ws\/projects\/([a-f0-9-]{36})$/);
      const w = m && account(user.id).workspaces.get(uuid(m[1])), current = online.get(deviceId);
      if (!w || w.grant.deviceId !== deviceId || !current || current.token !== token) throw Error('FORBIDDEN');
      const broker = projects.get(w.id).broker;
      socketServer.handleUpgrade(req, socket, head, ws => {
        ws._socket?.setKeepAlive?.(true, 15000);
        current.tools.add(ws);
        const rpc = new Rpc(ws, (method, params, frame) => {
          if (current !== online.get(deviceId)) throw Error('STALE_CONNECTION');
          directory.authenticate(token);
          return broker.peer(rpc, method, params, frame);
        });
        const timer = setTimeout(() => { if (!rpc.epoch) rpc.close(); }, 15000);
        ws.on('close', () => { clearTimeout(timer); current.tools.delete(ws); });
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  const heartbeat = setInterval(() => {
    for (const [id, p] of online) {
      try {
        directory.authenticate(p.token);
        if (Date.now() - p.lastSeen > 35000) detach(id, p);
        else {
          p.socket.ping();
          for (const toolWs of p.tools) {
            if (toolWs.readyState === 1) toolWs.ping();
          }
        }
      } catch { detach(id, p); }
    }
  }, 5000);
  server.headersTimeout = 20000; server.requestTimeout = 60000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  const reap = network && setInterval(() => network.sweep().catch(() => {}), 5000);
  return { port: server.address().port, async close() {
    clearInterval(heartbeat); clearInterval(reap);
    for (const closeStream of [...streams]) closeStream();
    await network?.sweeping?.catch(() => {});
    for (const id of online.keys()) detach(id);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const host of accounts.values()) await host.close();
    for (const p of projects.values()) { p.broker.close(); p.control.close(); p.store.close(); }
    socketServer.close();
  } };
}
