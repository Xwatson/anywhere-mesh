import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { DeviceClient, request } from '../client.mjs';
import contract from '../contract.cjs';
import { normalizeServerUrl } from '../server-config.mjs';

const knownErrors = new Set([
  'INVALID_CREDENTIALS', 'LOGIN_THROTTLED', 'DEVICE_DISABLED', 'LOGIN_REQUIRED',
  'INVALID_SERVER_URL', 'SERVER_URL_REQUIRED',
  'NETWORK_ENROLLMENT_UNAVAILABLE', 'NETWORK_ADDRESS_LIMIT',
  'LINUX_NETWORK_EXITED', 'LINUX_TUNNEL_NOT_READY', 'EADDRINUSE',
]);

export function makeBootstrap(serverUrl) {
  return (route, data, token) => request(serverUrl, { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    'POST', route, data, token, { idleMs: 15000, totalMs: 20000 });
}

async function phase(name, code, run, logSuccess = true, notify = null) {
  const started = Date.now();
  if (notify) notify({ phase: name, status: 'running' });
  const report = (result, error) => {
    const reason = error?.code ?? error?.message;
    console.error(JSON.stringify({
      component: 'linux-device', phase: name, result, elapsedMs: Date.now() - started,
      ...(error ? { code: /^[A-Z][A-Z0-9_]{0,60}$/.test(reason) ? reason : code } : {}),
    }));
  };
  try {
    const result = await run();
    if (logSuccess) report('ok');
    if (notify) notify({ phase: name, status: 'done' });
    return result;
  } catch (error) {
    report('failed', error);
    const reason = error.code ?? error.message;
    const failure = Error(knownErrors.has(reason) ? reason : code, { cause: error });
    failure.stage = failure.message;
    if (notify) notify({ phase: name, status: 'failed', code: failure.message });
    throw failure;
  }
}

export class LinuxClient extends DeviceClient {
  constructor(cfg, workspace, { peer, privatePaths = [], bootstrap = null, serverUrl = null, saveServerUrl = null }) {
    super({ ...cfg, workspacePicker: true }, workspace);
    this.peer = peer;
    const initial = serverUrl ?? cfg.serverUrl ?? (cfg.url && !/^https:\/\/127\.0\.0\.1(?::|$)/.test(cfg.url) ? cfg.url : null);
    this.serverUrl = initial ? normalizeServerUrl(initial) : null;
    this.saveServerUrl = saveServerUrl;
    if (this.serverUrl && typeof this.peer?.setServerUrl === 'function') this.peer.setServerUrl(this.serverUrl);
    this.tunnelTls = this.tls;
    this.publicTls = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
    this.directMode = false;
    this.privatePaths = privatePaths.map(p => {
      try { return realpathSync(resolve(p)); } catch { return resolve(p); }
    });
    this.customBootstrap = bootstrap;
    this.httpFailures = 0;
    this.probeFailures = 0;
    this.retryNetworkAt = 0;
    this.networkFailure = null;
    this.networkToken = null;
    this.tunnelReady = false;
    this.emitProgress = payload => { try { this.onStream?.({ type: 'connect_progress', payload }); } catch {} };
  }
  setServerUrl(url, { persist = true } = {}) {
    const normalized = normalizeServerUrl(url);
    this.serverUrl = normalized;
    if (typeof this.peer?.setServerUrl === 'function') this.peer.setServerUrl(normalized);
    if (persist) {
      try { this.saveServerUrl?.(normalized); } catch {}
    }
    try { this.onStream?.({ type: 'server_url', payload: { serverUrl: normalized } }); } catch {}
    return normalized;
  }
  callBootstrap(route, data, token, overrideUrl = null) {
    if (this.customBootstrap) return this.customBootstrap(route, data, token);
    const base = overrideUrl || this.serverUrl;
    if (!base) throw Error('SERVER_URL_REQUIRED');
    return makeBootstrap(base)(route, data, token);
  }
  workspacePath(selected) {
    if (typeof selected !== 'string' || !isAbsolute(selected)) throw Error('LOCAL_PROJECT_REQUIRED');
    let root;
    try { root = realpathSync(resolve(selected)); }
    catch { throw Error('LOCAL_PROJECT_REQUIRED'); }
    if (root === sep) throw Error('WORKSPACE_PATH_RESERVED');
    const defaultRoot = this.cfg.projects[0]?.path;
    if (defaultRoot && root === defaultRoot) return defaultRoot;
    for (const reserved of this.privatePaths) {
      if (root === reserved || root.startsWith(reserved + sep) || reserved.startsWith(root + sep)) {
        throw Error('WORKSPACE_PATH_RESERVED');
      }
    }
    return root;
  }
  async registerWorkspace(selected) {
    const folder = this.workspacePath(selected);
    let inode;
    try { inode = this.identifyRoot(folder); }
    catch { throw Error('LOCAL_PROJECT_REQUIRED'); }
    let root = this.profile.projects.find(p => p.path === folder);
    let migrated = false;
    if (root && root.inode !== inode) {
      if (this.canMigrateRoot && this.canMigrateRoot(root.inode, inode)) {
        root.inode = inode;
        this.persistProfileProjects();
        migrated = true;
      } else {
        throw Error('WORKSPACE_ROOT_CHANGED');
      }
    }
    if (!root) {
      if (this.profile.projects.length >= contract.workspaceLimit) throw Error('WORKSPACE_LIMIT');
      root = { path: folder, inode, localId: randomUUID(), label: basename(folder).trim().slice(0, 80) || '本机项目' };
      this.persistProfileProjects([...this.profile.projects, root]);
    }
    const signed = this.signed;
    let mapped;
    try { mapped = await this.api('POST', '/api/device/workspaces', { localId: root.localId, label: root.label }); }
    catch (error) { if (error.message === 'NOT_FOUND') throw Error('WORKSPACE_REGISTRATION_UNAVAILABLE'); throw error; }
    if (mapped.localId !== root.localId || mapped.deviceId !== signed.deviceId) throw Error('WORKSPACE_BINDING_MISMATCH');
    contract.validate('permission', { workspaceId: mapped.id, mode: 'revoked' });
    let existing = this.locals.get(mapped.id);
    if (existing && migrated) {
      clearTimeout(existing.retry);
      existing.rpc?.close();
      await existing.agent.close();
      existing.store.close();
      this.locals.delete(mapped.id);
      existing = null;
    }
    const local = existing ?? this.attachProject(signed, root, mapped, !migrated);
    if (existing) {
      try { local.available = this.verifyAndMigrateRoot(root); }
      catch { local.available = false; }
    }
    if (!local.available) {
      local.rpc?.close();
      throw Error('WORKSPACE_ROOT_CHANGED');
    }
    if (!local.rpc) this.connectProject(signed, this.presence, local);
    return this.localState({ projects: [{ ...mapped, mode: local.agent.grant.mode, ready: false }] }).projects[0];
  }
  async removeWorkspace(workspaceId) {
    const local = this.locals.get(workspaceId);
    if (!local) throw Error('ONLY_ON_BOUND_DEVICE');
    if (local.path === this.cfg.projects[0]?.path) throw Error('DEFAULT_WORKSPACE_PROTECTED');
    if (local.agent.journal.all('ops').some(o => !['succeeded', 'failed', 'cancelled', 'rejected', 'reviewed'].includes(o.state))) {
      throw Error('WORKSPACE_NOT_READY');
    }
    await this.api('DELETE', '/api/device/workspaces/' + workspaceId);
    clearTimeout(local.retry);
    local.rpc?.close();
    this.setMode(local, 'revoked');
    await local.agent.close();
    local.store.close();
    this.locals.delete(workspaceId);
    const projects = this.profile.projects.filter(p => p.localId !== local.localId);
    this.persistProfileProjects(projects);
    return { ok: true, id: workspaceId };
  }
  async authenticate(params, requestedUrl) {
    const targetUrl = requestedUrl ? normalizeServerUrl(requestedUrl) : this.serverUrl;
    if (!targetUrl && !this.customBootstrap) throw Error('SERVER_URL_REQUIRED');
    const signed = await phase('authentication', 'LINUX_BOOTSTRAP_UNAVAILABLE',
      () => this.callBootstrap('/api/auth/login', params, undefined, targetUrl), true, this.emitProgress);
    if (targetUrl) this.setServerUrl(targetUrl);
    return signed;
  }
  connect(signed) {
    if ((this.directMode || this.peer.child) && this.tunnelReady) super.connect(signed);
  }
  async ensureNetwork(signed, waitMs) {
    const peer = this.peer;
    const notify = !this.presence ? this.emitProgress : null;
    if ((!this.directMode && !peer.child) || this.networkToken !== signed.token || this.probeFailures >= 2) {
      const reqBody = process.env.ANYWHERE_MESH_TRANSPORT === 'easytier'
        ? { supportsDirect: true, prefer: 'easytier' }
        : { supportsDirect: true };
      const profile = await phase('network_enrollment', 'LINUX_NETWORK_CONFIG_UNAVAILABLE',
        () => this.callBootstrap('/api/device/network', reqBody, signed.token), true, notify);
      if (profile?.transport === 'direct') {
        this.directMode = true;
        this.tls = this.publicTls;
        this.cfg.url = this.serverUrl || this.cfg.url;
        this.networkToken = signed.token;
        this.tunnelReady = true;
        this.probeFailures = 0;
        if (peer.child) await peer.stop();
        if (notify) {
          notify({ phase: 'peer_start', status: 'done' });
          notify({ phase: 'tunnel_readiness', status: 'done' });
        }
        return;
      }
      this.directMode = false;
      this.tls = this.tunnelTls;
      this.tunnelReady = false;
      await phase('peer_start', 'LINUX_TUNNEL_NOT_READY', () => peer.start(profile, signed.deviceId, this.probeFailures >= 2), true, notify);
      this.cfg.url = 'https://127.0.0.1:' + peer.port;
      this.networkToken = signed.token;
      this.probeFailures = 0;
    }
    if (this.directMode && this.networkToken === signed.token) {
      this.tunnelReady = true;
      return;
    }
    if (this.tunnelReady) return;
    try {
      await phase('tunnel_readiness', 'LINUX_TUNNEL_NOT_READY', () => peer.ready(waitMs), true, notify);
      this.tunnelReady = true;
      this.probeFailures = 0;
    } catch (error) {
      this.probeFailures++;
      throw error;
    }
  }
  async verifiedState(saved) {
    if (saved?.serverUrl && saved.serverUrl !== this.serverUrl) {
      this.setServerUrl(saved.serverUrl, { persist: false });
    }
    if (!this.serverUrl && !this.customBootstrap) {
      throw Error('LOGIN_REQUIRED');
    }
    if (Date.now() < this.retryNetworkAt) throw this.networkFailure;
    const notify = !this.presence ? this.emitProgress : null;
    if (notify) notify({ phase: 'authentication', status: 'done' });
    try {
      await this.ensureNetwork(saved);
      const state = await phase('state_sync', 'LINUX_STATE_UNAVAILABLE', async () => {
        try { return await super.verifiedState(saved); }
        catch (error) {
          if (!['LOGIN_REQUIRED', 'DEVICE_DISABLED'].includes(error.message) && ++this.httpFailures >= 2) this.tunnelReady = false;
          throw error;
        }
      }, !this.presence, notify);
      this.httpFailures = 0;
      return state;
    } catch (error) {
      this.retryNetworkAt = Date.now() + 3000;
      this.networkFailure = error;
      throw error;
    }
  }
  async currentState() {
    const signed = this.signed;
    const state = await this.verifiedState(signed);
    if (state.user?.id !== signed.user.id || state.deviceId !== signed.deviceId) throw Error('LOGIN_BINDING_MISMATCH');
    this.connect(signed);
    return state;
  }
  async remoteLogout(signed) {
    if (this.peer.child && this.tunnelReady) {
      try { return await super.remoteLogout(signed); } catch {}
    }
    await this.callBootstrap('/api/auth/logout', {}, signed.token);
  }
  async signout(notify = true) {
    try { await super.signout(notify); }
    finally {
      this.retryNetworkAt = 0;
      this.networkFailure = null;
      this.httpFailures = 0;
      this.probeFailures = 0;
      this.directMode = false;
      this.tls = this.tunnelTls;
      this.networkToken = null;
      this.tunnelReady = false;
      await this.peer.stop();
    }
  }
  async recover(signed) {
    if (!signed || this.signed !== signed || ((this.directMode || this.peer.child) && this.tunnelReady && !this.httpFailures && this.presence?.readyState === 1)) return;
    try { await this.currentState(); }
    catch (error) {
      if (['LOGIN_REQUIRED', 'DEVICE_DISABLED', 'LOGIN_BINDING_MISMATCH'].includes(error.message)) await this.signout(false);
    }
  }
}
