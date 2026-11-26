'use strict';
const { BrowserWindow, session } = require('electron');
const { randomBytes, randomUUID } = require('node:crypto');
const http = require('node:http');

const PARTITION = 'persist:anywhere-dev-browser';
const MAX_LOGS = 100;

function isAllowedDevUrl(raw) {
  if (!raw || raw === 'about:blank') return true;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

class BuiltinBrowserBridge {
  constructor() {
    this.token = randomBytes(32).toString('hex');
    this.server = null;
    this.url = null;
    this.disposing = false;
    this.tabs = new Map(); // tabId -> { id, win, consoleLogs, networkLogs, reqMap, attached }
    this.activeTabId = null;
    this.devSession = null;
  }

  ensureSession() {
    if (this.devSession) return this.devSession;
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(['clipboard-read', 'clipboard-sanitized-write'].includes(permission));
    });
    this.devSession = ses;
    return ses;
  }

  async createTab({ url = 'about:blank', show = false } = {}) {
    if (!isAllowedDevUrl(url)) throw Error('URL_SCHEME_DENIED');
    const ses = this.ensureSession();
    const id = 'tab-' + randomUUID().slice(0, 8);
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      show: Boolean(show),
      title: 'AnywhereMesh 内置开发浏览器',
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        devTools: true,
        spellcheck: false,
      },
    });

    const tab = {
      id,
      win,
      consoleLogs: [],
      networkLogs: [],
      reqMap: new Map(),
      attached: false,
    };
    const pushBounded = (arr, item) => {
      arr.push(item);
      if (arr.length > MAX_LOGS) arr.splice(0, arr.length - MAX_LOGS);
    };

    const wc = win.webContents;
    wc.on('will-navigate', (event, targetUrl) => {
      if (!isAllowedDevUrl(targetUrl)) event.preventDefault();
    });
    wc.setWindowOpenHandler(({ url: targetUrl }) => {
      if (isAllowedDevUrl(targetUrl)) {
        void this.createTab({ url: targetUrl, show: win.isVisible() });
      }
      return { action: 'deny' };
    });
    win.on('close', event => {
      if (this.disposing || tab.forceClose) return;
      event.preventDefault();
      win.hide();
    });
    win.on('closed', () => {
      this.tabs.delete(id);
      if (this.activeTabId === id) {
        this.activeTabId = this.tabs.keys().next().value ?? null;
      }
    });

    try {
      wc.debugger.attach('1.3');
      tab.attached = true;
      wc.debugger.on('message', (_event, method, params = {}) => {
        if (method === 'Runtime.consoleAPICalled') {
          const text = (params.args ?? []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type || '')).join(' ');
          pushBounded(tab.consoleLogs, { ts: Date.now(), level: params.type || 'log', text: text.slice(0, 600) });
        } else if (method === 'Log.entryAdded') {
          const e = params.entry ?? {};
          pushBounded(tab.consoleLogs, { ts: Date.now(), level: e.level || 'info', text: String(e.text || '').slice(0, 600), url: e.url });
        } else if (method === 'Runtime.exceptionThrown') {
          const ex = params.exceptionDetails ?? {};
          pushBounded(tab.consoleLogs, { ts: Date.now(), level: 'error', text: String(ex.exception?.description || ex.text || 'Exception').slice(0, 600) });
        } else if (method === 'Network.requestWillBeSent') {
          if (params.requestId) tab.reqMap.set(params.requestId, { url: params.request?.url || '', method: params.request?.method || 'GET' });
        } else if (method === 'Network.responseReceived') {
          const req = tab.reqMap.get(params.requestId);
          const status = params.response?.status ?? 0;
          pushBounded(tab.networkLogs, {
            ts: Date.now(),
            method: req?.method || 'GET',
            status,
            url: String(params.response?.url || req?.url || '').slice(0, 400),
            mimeType: params.response?.mimeType || '',
            ok: status < 400,
          });
        } else if (method === 'Network.loadingFailed') {
          const req = tab.reqMap.get(params.requestId);
          pushBounded(tab.networkLogs, {
            ts: Date.now(),
            method: req?.method || 'GET',
            status: 0,
            url: String(req?.url || '').slice(0, 400),
            error: params.errorText || 'Failed',
            ok: false,
          });
        }
      });
      wc.debugger.on('detach', () => { tab.attached = false; });
      await Promise.allSettled([
        wc.debugger.sendCommand('Page.enable'),
        wc.debugger.sendCommand('DOM.enable'),
        wc.debugger.sendCommand('Runtime.enable'),
        wc.debugger.sendCommand('Log.enable'),
        wc.debugger.sendCommand('Network.enable'),
        wc.debugger.sendCommand('Accessibility.enable'),
      ]);
    } catch (err) {
      tab.forceClose = true;
      win.destroy();
      throw err;
    }

    this.tabs.set(id, tab);
    this.activeTabId = id;
    await win.loadURL(url || 'about:blank').catch(() => {});
    return tab;
  }

  async ensureTab(tabId, { show = false } = {}) {
    if (tabId) {
      const hit = this.tabs.get(tabId);
      if (!hit || hit.win.isDestroyed()) throw Error('BROWSER_TAB_NOT_FOUND');
      this.activeTabId = hit.id;
      if (show && !hit.win.isVisible()) hit.win.showInactive();
      return hit;
    }
    if (this.activeTabId) {
      const cur = this.tabs.get(this.activeTabId);
      if (cur && !cur.win.isDestroyed()) {
        if (show && !cur.win.isVisible()) cur.win.showInactive();
        return cur;
      }
    }
    return this.createTab({ url: 'about:blank', show });
  }

  describeTabs() {
    const out = [];
    for (const tab of this.tabs.values()) {
      if (tab.win.isDestroyed()) continue;
      out.push({
        id: tab.id,
        title: tab.win.webContents.getTitle() || '',
        url: tab.win.webContents.getURL() || 'about:blank',
        active: tab.id === this.activeTabId,
        visible: tab.win.isVisible(),
      });
    }
    return out;
  }

  async handleAction(action, params = {}) {
    if (action === 'status') {
      const tabs = this.describeTabs();
      return {
        connected: true,
        browser: 'Electron Built-in Chromium',
        tabCount: tabs.length,
        visible: tabs.some(t => t.visible),
        activeTabId: this.activeTabId,
      };
    }
    if (action === 'listTabs') {
      return { tabs: this.describeTabs() };
    }
    if (action === 'newTab') {
      const tab = await this.createTab({ url: params.url || 'about:blank', show: Boolean(params.autoShow) });
      return {
        id: tab.id,
        title: tab.win.webContents.getTitle() || '',
        url: tab.win.webContents.getURL() || params.url || 'about:blank',
        active: true,
      };
    }
    if (action === 'selectTab') {
      const tab = await this.ensureTab(params.tabId, { show: Boolean(params.autoShow) });
      if (params.autoShow) tab.win.show();
      return {
        id: tab.id,
        title: tab.win.webContents.getTitle() || '',
        url: tab.win.webContents.getURL() || '',
        active: true,
      };
    }
    if (action === 'closeTab') {
      const tab = this.tabs.get(params.tabId);
      if (!tab) throw Error('BROWSER_TAB_NOT_FOUND');
      tab.forceClose = true;
      if (!tab.win.isDestroyed()) tab.win.destroy();
      this.tabs.delete(params.tabId);
      return { closed: params.tabId };
    }
    if (action === 'show') {
      const tab = await this.ensureTab(this.activeTabId, { show: true });
      tab.win.show();
      tab.win.focus();
      return { ok: true, visible: true, tabId: tab.id };
    }
    if (action === 'hide') {
      for (const tab of this.tabs.values()) {
        if (!tab.win.isDestroyed()) tab.win.hide();
      }
      return { ok: true, visible: false };
    }
    if (action === 'reset') {
      for (const tab of [...this.tabs.values()]) {
        tab.forceClose = true;
        if (!tab.win.isDestroyed()) tab.win.destroy();
      }
      this.tabs.clear();
      this.activeTabId = null;
      if (this.devSession) {
        await this.devSession.clearStorageData().catch(() => {});
        await this.devSession.clearCache().catch(() => {});
      }
      return { ok: true };
    }
    if (action === 'getLogs') {
      const tab = await this.ensureTab(params.tabId, { show: false });
      const limit = Math.min(100, Math.max(1, Number(params.limit) || 40));
      const kind = params.kind || 'all';
      return {
        tabId: tab.id,
        console: kind === 'network' ? [] : tab.consoleLogs.slice(-limit),
        network: kind === 'console' ? [] : tab.networkLogs.slice(-limit),
      };
    }
    if (action === 'cdp') {
      const tab = await this.ensureTab(params.tabId, { show: Boolean(params.autoShow) });
      const wc = tab.win.webContents;
      if (!tab.attached) {
        wc.debugger.attach('1.3');
        tab.attached = true;
      }
      if (params.method === 'Page.navigate' && !isAllowedDevUrl(params.params?.url)) {
        throw Error('URL_SCHEME_DENIED');
      }
      const result = await wc.debugger.sendCommand(params.method, params.params || {});
      return { tabId: tab.id, result: result ?? {} };
    }
    throw Error('UNKNOWN_BUILTIN_ACTION');
  }

  async start() {
    if (this.server) return { url: this.url, token: this.token };
    const server = http.createServer(async (req, res) => {
      const reply = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST' || req.url !== '/action' || req.headers.authorization !== 'Bearer ' + this.token) {
        return reply(403, { error: 'FORBIDDEN' });
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 512 * 1024) return reply(413, { error: 'BODY_LIMIT' });
      }
      let msg;
      try { msg = JSON.parse(raw); } catch { return reply(400, { error: 'INVALID_JSON' }); }
      try {
        const result = await this.handleAction(msg.action, msg.params || {});
        return reply(200, { result });
      } catch (err) {
        return reply(200, { error: err?.message || 'BUILTIN_BROWSER_ERROR', code: err?.code });
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    this.server = server;
    this.url = `http://127.0.0.1:${addr.port}/action`;
    return { url: this.url, token: this.token };
  }

  async dispose() {
    this.disposing = true;
    for (const tab of [...this.tabs.values()]) {
      tab.forceClose = true;
      try { if (!tab.win.isDestroyed()) tab.win.destroy(); } catch {}
    }
    this.tabs.clear();
    this.activeTabId = null;
    if (this.server) {
      const s = this.server;
      this.server = null;
      s.closeAllConnections?.();
      await new Promise(resolve => s.close(resolve));
    }
  }
}

module.exports = { BuiltinBrowserBridge, isAllowedDevUrl };
