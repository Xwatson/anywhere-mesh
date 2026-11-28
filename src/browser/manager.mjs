import http from 'node:http';
import { fail } from '../execution/protocol.mjs';
import { BROWSER_READ_TOOL_NAMES, BROWSER_TOOL_NAMES } from '../workspace/catalog.mjs';
import { buildAccessibilitySnapshot } from './accessibility.mjs';
import { CdpSession, discoverDailyBrowser, findBrowserBinary, httpGetJson, launchDebugBrowser } from './cdp-client.mjs';
import { ExternalBrowserMcp } from './external-mcp.mjs';
import { BrowserSettingsStore } from './settings.mjs';

const WRITE_TOOLS = new Set([
  'browser_navigate', 'browser_click', 'browser_type', 'browser_press',
  'browser_scroll', 'browser_eval', 'browser_tab_action',
]);

const MAX_IMAGE_BASE64_BYTES = 240000;
const MAX_LOGS = 100;

const KEY_CODES = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

function parseKeySpec(spec) {
  const parts = String(spec || '').split('+').map(s => s.trim()).filter(Boolean);
  let modifiers = 0;
  let mainKey = parts.pop() || 'Enter';
  for (const mod of parts) {
    const lower = mod.toLowerCase();
    if (lower === 'alt' || lower === 'option') modifiers |= 1;
    else if (lower === 'control' || lower === 'ctrl') modifiers |= 2;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers |= 4;
    else if (lower === 'shift') modifiers |= 8;
  }
  const known = KEY_CODES[mainKey];
  if (known) {
    return {
      key: known.key ?? mainKey,
      code: known.code,
      windowsVirtualKeyCode: known.keyCode,
      modifiers,
      text: modifiers === 0 ? (known.text ?? '') : '',
    };
  }
  const ch = mainKey.length === 1 ? mainKey : '';
  const upper = ch ? ch.toUpperCase() : mainKey;
  const vk = ch ? upper.charCodeAt(0) : 0;
  return {
    key: mainKey,
    code: /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(upper) ? `Digit${upper}` : mainKey,
    windowsVirtualKeyCode: vk,
    modifiers,
    text: modifiers === 0 && ch ? ch : '',
  };
}

function postLoopbackJson(urlStr, token, body, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const raw = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
        Authorization: 'Bearer ' + token,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode && res.statusCode >= 400) {
            const err = Error(parsed?.error || `BUILTIN_BRIDGE_${res.statusCode}`);
            err.code = parsed?.code || parsed?.error;
            reject(err);
          } else if (parsed?.error) {
            const err = Error(parsed.error);
            err.code = parsed.code || parsed.error;
            reject(err);
          } else {
            resolve(parsed?.result ?? parsed);
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      const err = Error('BUILTIN_BRIDGE_TIMEOUT');
      err.code = 'BUILTIN_BRIDGE_TIMEOUT';
      req.destroy(err);
    });
    req.end(raw);
  });
}

class ElectronBuiltinBackend {
  constructor({ url, token }) {
    this.url = url;
    this.token = token;
  }

  call(action, params = {}) {
    return postLoopbackJson(this.url, this.token, { action, params });
  }

  async status() { return this.call('status'); }
  async listTabs() { return (await this.call('listTabs')).tabs ?? []; }
  async newTab(url, autoShow) { return this.call('newTab', { url, autoShow }); }
  async selectTab(tabId, autoShow) { return this.call('selectTab', { tabId, autoShow }); }
  async closeTab(tabId) { return this.call('closeTab', { tabId }); }
  async show() { return this.call('show'); }
  async hide() { return this.call('hide'); }
  async reset() { return this.call('reset'); }
  async getLogs(tabId, kind, limit) { return this.call('getLogs', { tabId, kind, limit }); }
  async sendCdp(tabId, method, params = {}, { autoShow = false } = {}) {
    return this.call('cdp', { tabId, method, params, autoShow });
  }
  async close() {
    await this.hide().catch(() => {});
  }
}

class CdpHttpBackend {
  constructor({ kind, getEndpoint, stateDir = null, launchHeadless = false }) {
    this.kind = kind;
    this.getEndpoint = getEndpoint;
    this.stateDir = stateDir;
    this.launchHeadless = launchHeadless;
    this.httpEndpoint = null;
    this.browserName = null;
    this.activeTabId = null;
    this.sessions = new Map(); // tabId -> { cdp, consoleLogs, networkLogs, reqMap }
    this.headlessProc = null;
  }

  async ensureEndpoint() {
    if (this.httpEndpoint) {
      try {
        const tabs = await httpGetJson(`${this.httpEndpoint}/json/list`, { timeoutMs: 2000 });
        if (Array.isArray(tabs)) return this.httpEndpoint;
      } catch {
        this.httpEndpoint = null;
      }
    }
    if (this.launchHeadless) {
      const launched = await launchDebugBrowser({
        stateDir: this.stateDir,
        port: 0,
        headless: true,
        profileName: 'builtin-headless-profile',
      });
      this.httpEndpoint = launched.httpEndpoint;
      this.browserName = launched.browser;
      this.headlessProc = launched.child;
      return this.httpEndpoint;
    }
    const found = await discoverDailyBrowser(this.getEndpoint(), { stateDir: this.stateDir });
    if (!found.ok) fail('DAILY_BROWSER_NOT_CONNECTED');
    this.httpEndpoint = found.httpEndpoint;
    this.browserName = found.browser;
    return this.httpEndpoint;
  }

  async listTabs() {
    const base = await this.ensureEndpoint();
    const list = await httpGetJson(`${base}/json/list`, { timeoutMs: 3000 });
    const pages = (Array.isArray(list) ? list : []).filter(t => t && t.type === 'page' && t.webSocketDebuggerUrl);
    if (pages.length && (!this.activeTabId || !pages.some(p => p.id === this.activeTabId))) {
      this.activeTabId = pages[0].id;
    }
    return pages.map(p => ({
      id: p.id,
      title: p.title || '',
      url: p.url || '',
      wsUrl: p.webSocketDebuggerUrl,
      active: p.id === this.activeTabId,
    }));
  }

  async ensureSession(tabId) {
    const tabs = await this.listTabs();
    if (!tabs.length) {
      const created = await this.newTab('about:blank');
      return this.ensureSession(created.id);
    }
    const target = tabId ? tabs.find(t => t.id === tabId) : (tabs.find(t => t.id === this.activeTabId) ?? tabs[0]);
    if (!target) fail('BROWSER_TAB_NOT_FOUND');
    this.activeTabId = target.id;
    let entry = this.sessions.get(target.id);
    if (entry && !entry.cdp.closed) return { entry, tab: target };

    const cdp = new CdpSession(target.wsUrl);
    await cdp.connect();
    entry = { cdp, consoleLogs: [], networkLogs: [], reqMap: new Map() };
    const pushBounded = (arr, item) => {
      arr.push(item);
      if (arr.length > MAX_LOGS) arr.splice(0, arr.length - MAX_LOGS);
    };
    cdp.on('Runtime.consoleAPICalled', p => {
      const text = (p.args ?? []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type || '')).join(' ');
      pushBounded(entry.consoleLogs, { ts: Date.now(), level: p.type || 'log', text: text.slice(0, 600) });
    });
    cdp.on('Log.entryAdded', p => {
      const e = p.entry ?? {};
      pushBounded(entry.consoleLogs, { ts: Date.now(), level: e.level || 'info', text: String(e.text || '').slice(0, 600), url: e.url });
    });
    cdp.on('Runtime.exceptionThrown', p => {
      const ex = p.exceptionDetails ?? {};
      const text = ex.exception?.description || ex.text || 'Uncaught exception';
      pushBounded(entry.consoleLogs, { ts: Date.now(), level: 'error', text: String(text).slice(0, 600) });
    });
    cdp.on('Network.requestWillBeSent', p => {
      if (p.requestId) entry.reqMap.set(p.requestId, { url: p.request?.url || '', method: p.request?.method || 'GET', ts: Date.now() });
    });
    cdp.on('Network.responseReceived', p => {
      const req = entry.reqMap.get(p.requestId);
      const status = p.response?.status ?? 0;
      pushBounded(entry.networkLogs, {
        ts: Date.now(),
        method: req?.method || 'GET',
        status,
        url: String(p.response?.url || req?.url || '').slice(0, 400),
        mimeType: p.response?.mimeType || '',
        ok: status < 400,
      });
    });
    cdp.on('Network.loadingFailed', p => {
      const req = entry.reqMap.get(p.requestId);
      pushBounded(entry.networkLogs, {
        ts: Date.now(),
        method: req?.method || 'GET',
        status: 0,
        url: String(req?.url || '').slice(0, 400),
        error: p.errorText || 'Failed',
        ok: false,
      });
    });
    cdp.on('__close__', () => {
      if (this.sessions.get(target.id) === entry) this.sessions.delete(target.id);
    });
    await Promise.allSettled([
      cdp.send('Page.enable'),
      cdp.send('DOM.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Log.enable'),
      cdp.send('Network.enable'),
      cdp.send('Accessibility.enable'),
    ]);
    this.sessions.set(target.id, entry);
    return { entry, tab: target };
  }

  async sendCdp(tabId, method, params = {}) {
    const { entry, tab } = await this.ensureSession(tabId);
    const result = await entry.cdp.send(method, params);
    return { tabId: tab.id, result };
  }

  async newTab(url = 'about:blank') {
    const base = await this.ensureEndpoint();
    const targetUrl = encodeURIComponent(url || 'about:blank');
    let created;
    try {
      created = await httpGetJson(`${base}/json/new?${targetUrl}`, { method: 'PUT', timeoutMs: 4000 });
    } catch {
      created = await httpGetJson(`${base}/json/new?${targetUrl}`, { method: 'GET', timeoutMs: 4000 });
    }
    if (!created?.id) fail('BROWSER_NEW_TAB_FAILED');
    this.activeTabId = created.id;
    return { id: created.id, title: created.title || '', url: created.url || url, active: true };
  }

  async selectTab(tabId) {
    const base = await this.ensureEndpoint();
    const tabs = await this.listTabs();
    const hit = tabs.find(t => t.id === tabId);
    if (!hit) fail('BROWSER_TAB_NOT_FOUND');
    await httpGetJson(`${base}/json/activate/${encodeURIComponent(tabId)}`, { timeoutMs: 3000 }).catch(() => {});
    this.activeTabId = tabId;
    return { id: hit.id, title: hit.title, url: hit.url, active: true };
  }

  async closeTab(tabId) {
    const base = await this.ensureEndpoint();
    const entry = this.sessions.get(tabId);
    if (entry) { entry.cdp.close(); this.sessions.delete(tabId); }
    await httpGetJson(`${base}/json/close/${encodeURIComponent(tabId)}`, { timeoutMs: 3000 }).catch(() => {});
    if (this.activeTabId === tabId) this.activeTabId = null;
    return { closed: tabId };
  }

  async getLogs(tabId, kind = 'all', limit = 40) {
    const { entry, tab } = await this.ensureSession(tabId);
    const consoleLogs = kind === 'network' ? [] : entry.consoleLogs.slice(-limit);
    const networkLogs = kind === 'console' ? [] : entry.networkLogs.slice(-limit);
    return { tabId: tab.id, console: consoleLogs, network: networkLogs };
  }

  async status() {
    if (!this.httpEndpoint && !this.launchHeadless) {
      const probe = await discoverDailyBrowser(this.getEndpoint(), { stateDir: this.stateDir });
      return { connected: probe.ok, browser: probe.browser ?? null, tabCount: probe.tabs?.length ?? 0, endpoint: probe.httpEndpoint ?? null };
    }
    try {
      const tabs = await this.listTabs();
      return { connected: true, browser: this.browserName || 'Chromium', tabCount: tabs.length, endpoint: this.httpEndpoint };
    } catch {
      return { connected: false, browser: null, tabCount: 0, endpoint: null };
    }
  }

  async close() {
    for (const entry of this.sessions.values()) entry.cdp.close();
    this.sessions.clear();
    this.activeTabId = null;
    if (this.headlessProc) {
      try { this.headlessProc.kill('SIGKILL'); } catch {}
      this.headlessProc = null;
      this.httpEndpoint = null;
    }
  }
}

export class BrowserManager {
  constructor({ stateDir = null, builtinBridgeUrl = null, builtinBridgeToken = null, onSettingsChange = null, initialSettings = null } = {}) {
    this.stateDir = stateDir;
    this.onSettingsChange = onSettingsChange;
    this.hasElectronBuiltin = Boolean(builtinBridgeUrl && builtinBridgeToken);
    this.hasLocalChrome = Boolean(findBrowserBinary());
    this.settingsStore = new BrowserSettingsStore(stateDir, {
      initial: initialSettings,
      onChange: (next, prev) => {
        if (prev?.builtin?.enabled && !next.builtin.enabled) void this.builtinBackend?.close();
        if (prev?.daily?.enabled && !next.daily.enabled) {
          void this.dailyCdpBackend.close();
          this.externalMcp?.close();
          this.externalMcp = null;
        }
        if (prev?.daily?.cdpUrl !== next.daily.cdpUrl || prev?.daily?.backend !== next.daily.backend) {
          void this.dailyCdpBackend.close();
          this.dailyCdpBackend.httpEndpoint = null;
          this.externalMcp?.close();
          this.externalMcp = null;
        }
        this.onSettingsChange?.(next, prev);
      },
    });
    this.builtinBackend = this.hasElectronBuiltin
      ? new ElectronBuiltinBackend({ url: builtinBridgeUrl, token: builtinBridgeToken })
      : this.hasLocalChrome
        ? new CdpHttpBackend({ kind: 'builtin', getEndpoint: () => 'auto', stateDir, launchHeadless: true })
        : null;
    this.dailyCdpBackend = new CdpHttpBackend({
      kind: 'daily',
      getEndpoint: () => this.settingsStore.get().daily.cdpUrl,
      stateDir,
      launchHeadless: false,
    });
    this.externalMcp = null;
    this.refCaches = new Map(); // `${target}:${tabId}` -> Map(ref -> { backendDOMNodeId, role, name })
  }

  getSettings() {
    return this.settingsStore.get();
  }

  updateSettings(patch) {
    return this.settingsStore.update(patch);
  }

  builtinKind() {
    if (this.hasElectronBuiltin) return 'electron';
    if (this.hasLocalChrome) return 'headless-chrome';
    return 'none';
  }

  publicState() {
    const s = this.settingsStore.get();
    return {
      builtin: {
        enabled: s.builtin.enabled && Boolean(this.builtinBackend),
        available: Boolean(this.builtinBackend),
        kind: this.builtinKind(),
        autoShow: s.builtin.autoShow,
      },
      daily: {
        enabled: s.daily.enabled,
        access: s.daily.access,
        backend: s.daily.backend,
      },
    };
  }

  supportedTools() {
    const pub = this.publicState();
    const anyEnabled = pub.builtin.enabled || pub.daily.enabled;
    if (!anyEnabled) return [];
    const canWrite = pub.builtin.enabled || (pub.daily.enabled && pub.daily.access !== 'read');
    return canWrite ? [...BROWSER_TOOL_NAMES] : [...BROWSER_READ_TOOL_NAMES];
  }

  async uiStatus() {
    const settings = this.settingsStore.get();
    const builtinAvailable = Boolean(this.builtinBackend);
    const builtinRuntime = builtinAvailable && settings.builtin.enabled
      ? await this.builtinBackend.status().catch(() => ({ connected: false }))
      : { connected: false, tabCount: 0 };
    const dailyProbe = settings.daily.enabled
      ? await discoverDailyBrowser(settings.daily.cdpUrl, { stateDir: this.stateDir }).catch(e => ({ ok: false, error: e.message }))
      : { ok: false, skipped: true };
    return {
      settings,
      builtin: {
        available: builtinAvailable,
        kind: this.builtinKind(),
        ...builtinRuntime,
      },
      daily: {
        connected: Boolean(dailyProbe.ok),
        browser: dailyProbe.browser ?? null,
        endpoint: dailyProbe.httpEndpoint ?? null,
        tabCount: dailyProbe.tabs?.length ?? 0,
        tabs: (dailyProbe.tabs ?? []).slice(0, 12).map(({ id, title, url }) => ({ id, title, url })),
        ...(dailyProbe.hint ? { hint: dailyProbe.hint } : {}),
        ...(dailyProbe.error ? { error: dailyProbe.error } : {}),
      },
      chromeInstalled: Boolean(findBrowserBinary()),
    };
  }

  async testDailyConnection(cdpUrl) {
    const targetUrl = cdpUrl !== undefined ? cdpUrl : this.settingsStore.get().daily.cdpUrl;
    const probe = await discoverDailyBrowser(targetUrl, { stateDir: this.stateDir });
    return {
      ok: probe.ok,
      browser: probe.browser ?? null,
      endpoint: probe.httpEndpoint ?? null,
      tabCount: probe.tabs?.length ?? 0,
      tabs: (probe.tabs ?? []).slice(0, 12).map(({ id, title, url }) => ({ id, title, url })),
      ...(probe.error ? { error: probe.error } : {}),
      ...(probe.hint ? { hint: probe.hint } : {}),
    };
  }

  async launchDailyBrowser(port = 9222) {
    const res = await launchDebugBrowser({ stateDir: this.stateDir, port, headless: false, profileName: 'daily-chrome-profile' });
    this.dailyCdpBackend.httpEndpoint = res.httpEndpoint;
    return {
      ok: true,
      endpoint: res.httpEndpoint,
      browser: res.browser,
      tabCount: res.tabs.length,
    };
  }

  async showBuiltinWindow() {
    if (!this.hasElectronBuiltin) fail('BUILTIN_WINDOW_UNAVAILABLE');
    return this.builtinBackend.show();
  }

  async hideBuiltinWindow() {
    if (!this.hasElectronBuiltin) fail('BUILTIN_WINDOW_UNAVAILABLE');
    return this.builtinBackend.hide();
  }

  async resetBuiltinBrowser() {
    if (!this.builtinBackend) fail('BUILTIN_WINDOW_UNAVAILABLE');
    for (const k of [...this.refCaches.keys()]) if (k.startsWith('builtin:')) this.refCaches.delete(k);
    if (this.hasElectronBuiltin) return this.builtinBackend.reset();
    await this.builtinBackend.close();
    return { ok: true };
  }

  resolveTarget(requestedTarget, tool) {
    const s = this.settingsStore.get();
    const builtinOn = s.builtin.enabled && Boolean(this.builtinBackend);
    const dailyOn = s.daily.enabled;
    if (!builtinOn && !dailyOn) fail('BROWSER_DISABLED');
    let target = requestedTarget;
    if (!target) {
      target = builtinOn ? 'builtin' : 'daily';
    }
    if (target === 'builtin') {
      if (!builtinOn) fail('BROWSER_BUILTIN_DISABLED');
      return { target: 'builtin', settings: s };
    }
    if (target === 'daily') {
      if (!dailyOn) fail('BROWSER_DAILY_DISABLED');
      if (WRITE_TOOLS.has(tool) && s.daily.access === 'read') fail('BROWSER_DAILY_READONLY');
      return { target: 'daily', settings: s };
    }
    fail('INVALID_BROWSER_TARGET');
  }

  async getExternalMcp(settings) {
    const probe = await discoverDailyBrowser(settings.daily.cdpUrl, { stateDir: this.stateDir });
    if (!probe.ok) fail('DAILY_BROWSER_NOT_CONNECTED');
    if (this.externalMcp && this.externalMcp.backend === settings.daily.backend && this.externalMcp.httpEndpoint === probe.httpEndpoint) {
      return this.externalMcp;
    }
    this.externalMcp?.close();
    this.externalMcp = new ExternalBrowserMcp({ backend: settings.daily.backend, httpEndpoint: probe.httpEndpoint });
    return this.externalMcp;
  }

  async resolveElementBox(backend, target, tabId, { ref, selector }, autoShow) {
    const send = (method, params) => backend.sendCdp(tabId, method, params, { autoShow });
    let objectId = null;
    if (ref) {
      const cache = this.refCaches.get(`${target}:${tabId}`);
      const info = cache?.get(ref);
      if (!info?.backendDOMNodeId) fail('BROWSER_REF_NOT_FOUND');
      await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: info.backendDOMNodeId }).catch(() => {});
      const resolved = await send('DOM.resolveNode', { backendNodeId: info.backendDOMNodeId });
      objectId = resolved.result?.object?.objectId;
    } else if (selector) {
      const evalRes = await send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollIntoView({ block: 'center', inline: 'center' }); return el; })()`,
        returnByValue: false,
      });
      objectId = evalRes.result?.result?.objectId;
    }
    if (!objectId) fail('BROWSER_ELEMENT_NOT_FOUND');
    const boxRes = await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        const r = this.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, left: r.left, top: r.top };
      }`,
      returnByValue: true,
    });
    const box = boxRes.result?.result?.value;
    return { objectId, box };
  }

  async execute(tool, args = {}) {
    if (tool === 'browser_status') {
      const pub = this.publicState();
      const details = {
        builtin: pub.builtin.enabled
          ? { ...pub.builtin, ...(await this.builtinBackend.status().catch(() => ({ connected: false }))) }
          : pub.builtin,
        daily: pub.daily.enabled
          ? { ...pub.daily, ...(await this.dailyCdpBackend.status().catch(() => ({ connected: false }))) }
          : pub.daily,
      };
      return { version: 1, ok: true, calls: 1, response: { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] } };
    }

    const { target, settings } = this.resolveTarget(args.target, tool);

    // Optional external open-source MCP backend for daily browser
    if (target === 'daily' && settings.daily.backend !== 'cdp') {
      const mcp = await this.getExternalMcp(settings);
      const res = await mcp.callMapped(tool, args);
      const content = Array.isArray(res?.content) && res.content.length
        ? res.content
        : [{ type: 'text', text: JSON.stringify(res) }];
      return {
        version: 1,
        ok: !res?.isError,
        committed: WRITE_TOOLS.has(tool),
        calls: 1,
        response: { ...(res?.isError ? { isError: true } : {}), content },
      };
    }

    const backend = target === 'builtin' ? this.builtinBackend : this.dailyCdpBackend;
    const autoShow = target === 'builtin' && Boolean(settings.builtin.autoShow);

    if (tool === 'browser_tabs') {
      const tabs = await backend.listTabs();
      return {
        version: 1, ok: true, calls: 1,
        response: { content: [{ type: 'text', text: JSON.stringify({ target, tabs: tabs.map(({ id, title, url, active }) => ({ id, title, url, active })) }, null, 2) }] },
      };
    }

    if (tool === 'browser_tab_action') {
      let result;
      if (args.action === 'new') result = await backend.newTab(args.url || 'about:blank', autoShow);
      else if (args.action === 'select') result = await backend.selectTab(args.tabId, autoShow);
      else if (args.action === 'close') {
        result = await backend.closeTab(args.tabId);
        this.refCaches.delete(`${target}:${args.tabId}`);
      } else fail('INVALID_FIELDS');
      return { version: 1, ok: true, committed: true, calls: 1, response: { content: [{ type: 'text', text: JSON.stringify({ target, ...result }, null, 2) }] } };
    }

    if (tool === 'browser_logs') {
      const logs = await backend.getLogs(args.tabId, args.kind ?? 'all', args.limit ?? 40);
      return { version: 1, ok: true, calls: 1, response: { content: [{ type: 'text', text: JSON.stringify({ target, ...logs }, null, 2) }] } };
    }

    const cdp = (method, params = {}, showNow = false) => backend.sendCdp(args.tabId, method, params, { autoShow: showNow });

    if (tool === 'browser_navigate') {
      const action = args.action ?? 'goto';
      let tabId = args.tabId;
      if (action === 'goto') {
        const nav = await cdp('Page.navigate', { url: args.url }, autoShow);
        tabId = nav.tabId;
        if (nav.result?.errorText) {
          return { version: 1, ok: false, committed: true, error: 'NAVIGATION_FAILED', response: { isError: true, content: [{ type: 'text', text: `Navigation failed: ${nav.result.errorText}` }] } };
        }
      } else if (action === 'reload') {
        tabId = (await cdp('Page.reload', {}, autoShow)).tabId;
      } else if (action === 'back' || action === 'forward') {
        const hist = await cdp('Page.getNavigationHistory', {}, autoShow);
        tabId = hist.tabId;
        const idx = hist.result?.currentIndex ?? 0;
        const entries = hist.result?.entries ?? [];
        const nextIdx = action === 'back' ? idx - 1 : idx + 1;
        if (nextIdx >= 0 && nextIdx < entries.length) {
          await backend.sendCdp(tabId, 'Page.navigateToHistoryEntry', { entryId: entries[nextIdx].id }, { autoShow });
        }
      }
      const wantState = args.waitUntil === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete'];
      const deadline = Date.now() + 10000;
      let pageMeta = { url: args.url || '', title: '' };
      while (Date.now() < deadline) {
        try {
          const check = await backend.sendCdp(tabId, 'Runtime.evaluate', {
            expression: '({ readyState: document.readyState, url: location.href, title: document.title })',
            returnByValue: true,
          });
          const v = check.result?.result?.value;
          if (v) {
            pageMeta = { url: v.url, title: v.title };
            if (wantState.includes(v.readyState)) break;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 150));
      }
      this.refCaches.delete(`${target}:${tabId}`);
      return {
        version: 1, ok: true, committed: true, calls: 1,
        response: { content: [{ type: 'text', text: JSON.stringify({ target, tabId, action, ...pageMeta }, null, 2) }] },
      };
    }

    if (tool === 'browser_snapshot') {
      const metaRes = await cdp('Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title })',
        returnByValue: true,
      });
      const tabId = metaRes.tabId;
      const meta = metaRes.result?.result?.value ?? { url: '', title: '' };
      const axRes = await backend.sendCdp(tabId, 'Accessibility.getFullAXTree', {});
      const snap = buildAccessibilitySnapshot(axRes.result?.nodes ?? [], {
        maxNodes: args.maxNodes ?? 300,
        url: meta.url,
        title: meta.title,
      });
      this.refCaches.set(`${target}:${tabId}`, snap.refMap);
      return {
        version: 1, ok: true, calls: 1,
        response: { content: [{ type: 'text', text: `[target=${target} tabId=${tabId} nodes=${snap.nodeCount}]\n${snap.text}` }] },
      };
    }

    if (tool === 'browser_screenshot') {
      const metaRes = await cdp('Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title })',
        returnByValue: true,
      });
      const tabId = metaRes.tabId;
      const meta = metaRes.result?.result?.value ?? { url: '', title: '' };
      let clip;
      if (args.selector) {
        const { box } = await this.resolveElementBox(backend, target, tabId, { selector: args.selector }, false);
        if (box && box.width > 0 && box.height > 0) {
          clip = { x: Math.max(0, box.left), y: Math.max(0, box.top), width: box.width, height: box.height, scale: 1 };
        }
      }
      let data = '';
      for (const quality of [75, 55, 38, 25]) {
        const shot = await backend.sendCdp(tabId, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality,
          ...(args.fullPage && !clip ? { captureBeyondViewport: true } : {}),
          ...(clip ? { clip } : {}),
        });
        data = shot.result?.data || '';
        if (data.length <= MAX_IMAGE_BASE64_BYTES) break;
      }
      if (!data) fail('SCREENSHOT_FAILED');
      if (data.length > MAX_IMAGE_BASE64_BYTES) {
        // Fallback to viewport-only low-quality screenshot if fullPage exceeded frame budget
        const shot = await backend.sendCdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 35 });
        data = shot.result?.data || '';
      }
      const approxKb = Math.round((data.length * 3) / 4 / 1024);
      return {
        version: 1,
        ok: true,
        calls: 1,
        response: {
          content: [
            { type: 'image', data, mimeType: 'image/jpeg' },
            { type: 'text', text: `Screenshot captured (${target}, tabId=${tabId}, ~${approxKb} KB): ${meta.title || '(untitled)'} (${meta.url})` },
          ],
        },
      };
    }

    if (tool === 'browser_click') {
      const init = await cdp('Runtime.evaluate', { expression: '1', returnByValue: true }, autoShow);
      const tabId = init.tabId;
      let cx = args.x, cy = args.y;
      if (args.ref || args.selector) {
        const { box } = await this.resolveElementBox(backend, target, tabId, { ref: args.ref, selector: args.selector }, autoShow);
        if (!box || (box.width === 0 && box.height === 0)) fail('BROWSER_ELEMENT_HIDDEN');
        cx = Math.round(box.x);
        cy = Math.round(box.y);
      }
      const button = args.button ?? 'left';
      const clickCount = args.doubleClick ? 2 : 1;
      await backend.sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' }, { autoShow });
      for (let i = 1; i <= clickCount; i++) {
        await backend.sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button, clickCount: i }, { autoShow });
        await backend.sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button, clickCount: i }, { autoShow });
      }
      return {
        version: 1, ok: true, committed: true, calls: 1,
        response: { content: [{ type: 'text', text: JSON.stringify({ target, tabId, clicked: args.ref ?? args.selector ?? `${cx},${cy}`, x: cx, y: cy }) }] },
      };
    }

    if (tool === 'browser_type') {
      const init = await cdp('Runtime.evaluate', { expression: '1', returnByValue: true }, autoShow);
      const tabId = init.tabId;
      const { objectId } = await this.resolveElementBox(backend, target, tabId, { ref: args.ref, selector: args.selector }, autoShow);
      const clear = args.clear !== false;
      await backend.sendCdp(tabId, 'Runtime.callFunctionOn', {
        objectId,
        arguments: [{ value: clear }],
        functionDeclaration: `function(shouldClear) {
          this.focus();
          if (shouldClear) {
            if ('value' in this && typeof this.value === 'string') {
              const proto = Object.getPrototypeOf(this);
              const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
              if (desc && desc.set) desc.set.call(this, '');
              else this.value = '';
              this.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (this.isContentEditable) {
              this.textContent = '';
              this.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
        }`,
        returnByValue: true,
      }, { autoShow });
      if (args.text) {
        await backend.sendCdp(tabId, 'Input.insertText', { text: args.text }, { autoShow });
      }
      if (args.submit) {
        const enter = parseKeySpec('Enter');
        await backend.sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...enter }, { autoShow });
        await backend.sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...enter }, { autoShow });
      }
      return {
        version: 1, ok: true, committed: true, calls: 1,
        response: { content: [{ type: 'text', text: JSON.stringify({ target, tabId, typedLength: args.text.length, cleared: clear, submitted: Boolean(args.submit) }) }] },
      };
    }

    if (tool === 'browser_press') {
      const spec = parseKeySpec(args.key);
      const first = await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...spec }, autoShow);
      await backend.sendCdp(first.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...spec }, { autoShow });
      return {
        version: 1, ok: true, committed: true, calls: 1,
        response: { content: [{ type: 'text', text: JSON.stringify({ target, tabId: first.tabId, key: args.key }) }] },
      };
    }

    if (tool === 'browser_scroll') {
      const init = await cdp('Runtime.evaluate', { expression: '1', returnByValue: true }, autoShow);
      const tabId = init.tabId;
      if (args.ref || args.selector) {
        const { objectId } = await this.resolveElementBox(backend, target, tabId, { ref: args.ref, selector: args.selector }, autoShow);
        await backend.sendCdp(tabId, 'Runtime.callFunctionOn', {
          objectId,
          arguments: [{ value: args.deltaX ?? 0 }, { value: args.deltaY ?? 0 }, { value: args.to ?? '' }],
          functionDeclaration: `function(dx, dy, to) {
            if (to === 'top') this.scrollTop = 0;
            else if (to === 'bottom') this.scrollTop = this.scrollHeight;
            else this.scrollBy(dx, dy);
          }`,
          returnByValue: true,
        }, { autoShow });
      } else {
        const dx = Math.round(args.deltaX ?? 0);
        const dy = Math.round(args.deltaY ?? (args.to ? 0 : 600));
        const expr = args.to === 'top'
          ? 'window.scrollTo(0, 0)'
          : args.to === 'bottom'
            ? 'window.scrollTo(0, document.documentElement.scrollHeight)'
            : `window.scrollBy(${dx}, ${dy})`;
        await backend.sendCdp(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true }, { autoShow });
      }
      return {
        version: 1, ok: true, committed: true, calls: 1,
        response: { content: [{ type: 'text', text: JSON.stringify({ target, tabId, scrolled: true }) }] },
      };
    }

    if (tool === 'browser_wait') {
      const timeoutMs = args.timeoutMs ?? 5000;
      if (!args.text && !args.selector) {
        await new Promise(r => setTimeout(r, timeoutMs));
        return { version: 1, ok: true, calls: 1, response: { content: [{ type: 'text', text: `Waited ${timeoutMs}ms.` }] } };
      }
      const deadline = Date.now() + timeoutMs;
      let tabId = args.tabId;
      while (Date.now() < deadline) {
        const expr = args.selector
          ? `Boolean(document.querySelector(${JSON.stringify(args.selector)}))`
          : `Boolean(document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(args.text)}))`;
        const res = await backend.sendCdp(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
        tabId = res.tabId;
        if (res.result?.result?.value === true) {
          return { version: 1, ok: true, calls: 1, response: { content: [{ type: 'text', text: JSON.stringify({ target, tabId, matched: true }) }] } };
        }
        await new Promise(r => setTimeout(r, 150));
      }
      return {
        version: 1, ok: false, error: 'BROWSER_WAIT_TIMEOUT',
        response: { isError: true, content: [{ type: 'text', text: `Timed out after ${timeoutMs}ms waiting for ${args.selector || args.text}` }] },
      };
    }

    if (tool === 'browser_eval') {
      const res = await cdp('Runtime.evaluate', {
        expression: args.expression,
        awaitPromise: true,
        returnByValue: true,
      }, autoShow);
      if (res.result?.exceptionDetails) {
        const msg = res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text || 'Evaluation failed';
        return { version: 1, ok: false, committed: true, error: 'BROWSER_EVAL_ERROR', response: { isError: true, content: [{ type: 'text', text: String(msg).slice(0, 4000) }] } };
      }
      const rawVal = res.result?.result?.value;
      const out = rawVal === undefined ? 'undefined' : (typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal, null, 2));
      return {
        version: 1, ok: true, committed: true, calls: 1,
        response: { content: [{ type: 'text', text: String(out).slice(0, 16000) }] },
      };
    }

    fail('TOOL_DENIED');
  }

  async close() {
    await Promise.allSettled([
      this.builtinBackend?.close?.(),
      this.dailyCdpBackend.close(),
    ]);
    this.externalMcp?.close();
    this.externalMcp = null;
  }
}
