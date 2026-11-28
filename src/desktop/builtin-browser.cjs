'use strict';
const { WebContentsView, session } = require('electron');
const { randomBytes, randomUUID } = require('node:crypto');
const http = require('node:http');

const PARTITION = 'persist:anywhere-dev-browser';
const MAX_LOGS = 100;
const CDP_ENABLE_TIMEOUT_MS = 5000;
const DEFAULT_HIDDEN_BOUNDS = Object.freeze({ x: 0, y: 0, width: 1280, height: 820 });

function isAllowedDevUrl(raw) {
  if (!raw || raw === 'about:blank') return true;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRealPageUrl(raw) {
  if (!raw || raw === 'about:blank') return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function withTimeout(promise, ms, code = 'BUILTIN_CDP_TIMEOUT') {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = Error(code);
        err.code = code;
        reject(err);
      }, ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function canGoBackOf(wc) {
  if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === 'function') {
    return Boolean(wc.navigationHistory.canGoBack());
  }
  return Boolean(wc.canGoBack?.());
}

function canGoForwardOf(wc) {
  if (wc.navigationHistory && typeof wc.navigationHistory.canGoForward === 'function') {
    return Boolean(wc.navigationHistory.canGoForward());
  }
  return Boolean(wc.canGoForward?.());
}

function sanitizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = Math.max(0, Math.round(Number(bounds.x)));
  const y = Math.max(0, Math.round(Number(bounds.y)));
  const width = Math.max(0, Math.round(Number(bounds.width)));
  const height = Math.max(0, Math.round(Number(bounds.height)));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { x, y, width, height };
}

class BuiltinBrowserBridge {
  constructor({ onStateChange = null } = {}) {
    this.token = randomBytes(32).toString('hex');
    this.server = null;
    this.url = null;
    this.disposing = false;
    this.hostWin = null;
    this.onStateChange = onStateChange;
    this.tabs = new Map(); // tabId -> { id, view, consoleLogs, networkLogs, reqMap, attached }
    this.activeTabId = null;
    this.devSession = null;
    this.panelOpen = false;
    this.panelCovered = false;
    this.dockBounds = null;
  }

  attachHostWindow(win) {
    this.hostWin = win || null;
    this.syncViews();
    this.emitState();
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

  hasHostWindow() {
    return Boolean(this.hostWin && !this.hostWin.isDestroyed());
  }

  destroyTabView(tab) {
    if (!tab?.view) return;
    this.endHiddenCompositor(tab);
    try {
      if (this.hasHostWindow()) {
        this.hostWin.contentView.removeChildView(tab.view);
      }
    } catch {}
    try {
      const wc = tab.view.webContents;
      if (wc && !wc.isDestroyed()) {
        try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
        wc.close({ waitForBeforeUnload: false });
      }
    } catch {}
  }

  endHiddenCompositor(tab) {
    if (!tab) return;
    if (tab.hiddenSubTimer) {
      clearTimeout(tab.hiddenSubTimer);
      tab.hiddenSubTimer = null;
    }
    if (tab.hiddenSub) {
      tab.hiddenSub = false;
      try {
        const wc = tab.view?.webContents;
        if (wc && !wc.isDestroyed()) wc.endFrameSubscription();
      } catch {}
    }
  }

  async ensureHiddenCompositor(tab) {
    if (!tab || tab.lastVisible) return;
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const resetIdle = () => {
      if (tab.hiddenSubTimer) clearTimeout(tab.hiddenSubTimer);
      tab.hiddenSubTimer = setTimeout(() => this.endHiddenCompositor(tab), 15000);
      tab.hiddenSubTimer.unref?.();
    };
    if (tab.hiddenSub) {
      resetIdle();
      return;
    }
    tab.hiddenSub = true;
    resetIdle();
    await new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, 300);
      try {
        wc.beginFrameSubscription(false, () => done());
        wc.invalidate?.();
      } catch {
        tab.hiddenSub = false;
        done();
      }
    });
    if (tab.attached) {
      // Force Viz to commit a hit-test surface once for hidden views so Input.* succeeds immediately.
      await withTimeout(
        wc.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } }),
        2000,
      ).catch(() => {});
    }
  }

  describeTab(tab) {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    const url = wc.getURL() || 'about:blank';
    return {
      id: tab.id,
      title: wc.getTitle() || '',
      url,
      active: tab.id === this.activeTabId,
      loading: Boolean(wc.isLoading()),
      canGoBack: canGoBackOf(wc),
      canGoForward: canGoForwardOf(wc),
    };
  }

  describeTabs() {
    const out = [];
    for (const tab of this.tabs.values()) {
      const info = this.describeTab(tab);
      if (info) out.push(info);
    }
    return out;
  }

  uiSnapshot() {
    const tabs = this.describeTabs();
    const activeTab = tabs.find(t => t.active) || tabs[0] || null;
    const hasActivePage = tabs.some(t => isRealPageUrl(t.url));
    const activeHasPage = Boolean(activeTab && isRealPageUrl(activeTab.url));
    const canShowBounds = Boolean(this.dockBounds && this.dockBounds.width >= 80 && this.dockBounds.height >= 80);
    const visible = Boolean(this.panelOpen && !this.panelCovered && activeHasPage && canShowBounds);
    return {
      connected: true,
      browser: 'Electron Built-in Chromium',
      docked: true,
      open: this.panelOpen,
      covered: this.panelCovered,
      visible,
      tabCount: tabs.length,
      hasActivePage,
      activeTabId: activeTab?.id ?? null,
      activeUrl: activeTab?.url || '',
      activeTitle: activeTab?.title || '',
      loading: Boolean(activeTab?.loading),
      canGoBack: Boolean(activeTab?.canGoBack),
      canGoForward: Boolean(activeTab?.canGoForward),
      tabs,
    };
  }

  emitState() {
    if (this.disposing || typeof this.onStateChange !== 'function') return;
    try {
      this.onStateChange(this.uiSnapshot());
    } catch {}
  }

  syncViews() {
    if (!this.hasHostWindow()) return;
    const activeTab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    const activeWc = activeTab?.view?.webContents;
    const activeUrl = activeWc && !activeWc.isDestroyed() ? (activeWc.getURL() || 'about:blank') : 'about:blank';
    const hasDockedRect = Boolean(this.dockBounds && this.dockBounds.width >= 80 && this.dockBounds.height >= 80);
    const showActive = Boolean(this.panelOpen && !this.panelCovered && hasDockedRect && activeTab && isRealPageUrl(activeUrl));

    for (const tab of this.tabs.values()) {
      const wc = tab.view?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      const wantVisible = Boolean(tab === activeTab && showActive);
      const wantBounds = wantVisible
        ? this.dockBounds
        : (tab === activeTab
            ? (this.panelOpen && hasDockedRect ? this.dockBounds : DEFAULT_HIDDEN_BOUNDS)
            : null);
      if (wantBounds) {
        const b = tab.lastBounds;
        if (!b || b.x !== wantBounds.x || b.y !== wantBounds.y || b.width !== wantBounds.width || b.height !== wantBounds.height) {
          tab.view.setBounds(wantBounds);
          tab.lastBounds = { ...wantBounds };
        }
      }
      if (tab.lastVisible !== wantVisible) {
        if (wantVisible) this.endHiddenCompositor(tab);
        tab.view.setVisible(wantVisible);
        tab.lastVisible = wantVisible;
      }
    }
  }

  async createTab({ url = 'about:blank', show = false } = {}) {
    if (!isAllowedDevUrl(url)) {
      const err = Error('URL_SCHEME_DENIED');
      err.code = 'URL_SCHEME_DENIED';
      throw err;
    }
    if (!this.hasHostWindow()) {
      const err = Error('BUILTIN_WINDOW_UNAVAILABLE');
      err.code = 'BUILTIN_WINDOW_UNAVAILABLE';
      throw err;
    }
    const ses = this.ensureSession();
    const id = 'tab-' + randomUUID().slice(0, 8);
    const view = new WebContentsView({
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
        backgroundThrottling: false,
      },
    });

    const tab = {
      id,
      view,
      consoleLogs: [],
      networkLogs: [],
      reqMap: new Map(),
      attached: false,
      lastVisible: false,
      lastBounds: null,
      hiddenSub: false,
      hiddenSubTimer: null,
    };
    const pushBounded = (arr, item) => {
      arr.push(item);
      if (arr.length > MAX_LOGS) arr.splice(0, arr.length - MAX_LOGS);
    };

    const initialBounds = (this.panelOpen || show) && this.dockBounds && this.dockBounds.width >= 80 && this.dockBounds.height >= 80
      ? this.dockBounds
      : DEFAULT_HIDDEN_BOUNDS;
    this.hostWin.contentView.addChildView(view);
    view.setBounds(initialBounds);
    tab.lastBounds = { ...initialBounds };
    view.setVisible(false);

    const wc = view.webContents;
    wc.on('will-navigate', (event, targetUrl) => {
      if (!isAllowedDevUrl(targetUrl)) event.preventDefault();
    });
    wc.setWindowOpenHandler(({ url: targetUrl }) => {
      if (isAllowedDevUrl(targetUrl)) {
        void this.createTab({ url: targetUrl, show: this.panelOpen }).catch(() => {});
      }
      return { action: 'deny' };
    });
    wc.on('destroyed', () => {
      this.tabs.delete(id);
      if (this.activeTabId === id) {
        this.activeTabId = this.tabs.keys().next().value ?? null;
      }
      this.syncViews();
      this.emitState();
    });

    try {
      // Electron 45+ requires an initialized renderer (initial loadURL) before CDP *.enable resolves.
      await withTimeout(wc.loadURL('about:blank'), 8000, 'BUILTIN_TAB_INIT_TIMEOUT');
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
        withTimeout(wc.debugger.sendCommand('Page.enable'), CDP_ENABLE_TIMEOUT_MS),
        withTimeout(wc.debugger.sendCommand('DOM.enable'), CDP_ENABLE_TIMEOUT_MS),
        withTimeout(wc.debugger.sendCommand('Runtime.enable'), CDP_ENABLE_TIMEOUT_MS),
        withTimeout(wc.debugger.sendCommand('Log.enable'), CDP_ENABLE_TIMEOUT_MS),
        withTimeout(wc.debugger.sendCommand('Network.enable'), CDP_ENABLE_TIMEOUT_MS),
        withTimeout(wc.debugger.sendCommand('Accessibility.enable'), CDP_ENABLE_TIMEOUT_MS),
      ]);
    } catch (err) {
      this.destroyTabView(tab);
      throw err;
    }

    const notify = () => {
      this.syncViews();
      this.emitState();
    };
    wc.on('did-start-loading', notify);
    wc.on('did-stop-loading', notify);
    wc.on('did-navigate', () => {
      this.endHiddenCompositor(tab);
      notify();
    });
    wc.on('did-navigate-in-page', notify);
    wc.on('page-title-updated', notify);
    wc.on('did-fail-load', notify);

    this.tabs.set(id, tab);
    this.activeTabId = id;
    if (show) this.panelOpen = true;
    if (url && url !== 'about:blank') {
      await wc.loadURL(url).catch(() => {});
    }
    this.syncViews();
    this.emitState();
    return tab;
  }

  async ensureTab(tabId, { show = false } = {}) {
    if (tabId) {
      const hit = this.tabs.get(tabId);
      if (!hit || !hit.view?.webContents || hit.view.webContents.isDestroyed()) {
        const err = Error('BROWSER_TAB_NOT_FOUND');
        err.code = 'BROWSER_TAB_NOT_FOUND';
        throw err;
      }
      const changed = this.activeTabId !== hit.id || (show && !this.panelOpen);
      this.activeTabId = hit.id;
      if (show) this.panelOpen = true;
      if (changed) {
        this.syncViews();
        this.emitState();
      }
      return hit;
    }
    if (this.activeTabId) {
      const cur = this.tabs.get(this.activeTabId);
      if (cur && cur.view?.webContents && !cur.view.webContents.isDestroyed()) {
        const changed = Boolean(show && !this.panelOpen);
        if (show) this.panelOpen = true;
        if (changed) {
          this.syncViews();
          this.emitState();
        }
        return cur;
      }
    }
    return this.createTab({ url: 'about:blank', show });
  }

  syncDock({ open, covered, bounds } = {}) {
    if (typeof open === 'boolean') this.panelOpen = open;
    if (typeof covered === 'boolean') this.panelCovered = covered;
    if (bounds !== undefined) {
      const next = sanitizeBounds(bounds);
      if (next) this.dockBounds = next;
    }
    this.syncViews();
    return this.uiSnapshot();
  }

  async dockNavigate({ action, url, tabId } = {}) {
    if (action === 'goto') {
      if (!url || !isAllowedDevUrl(url)) {
        const err = Error('URL_SCHEME_DENIED');
        err.code = 'URL_SCHEME_DENIED';
        throw err;
      }
      this.panelOpen = true;
      const tab = await this.ensureTab(tabId, { show: true });
      await tab.view.webContents.loadURL(url).catch(() => {});
      this.syncViews();
      const snap = this.uiSnapshot();
      this.emitState();
      return snap;
    }
    if (action === 'newTab') {
      const targetUrl = url || 'about:blank';
      this.panelOpen = true;
      await this.createTab({ url: targetUrl, show: true });
      return this.uiSnapshot();
    }
    if (action === 'selectTab') {
      await this.ensureTab(tabId, { show: this.panelOpen });
      return this.uiSnapshot();
    }
    if (action === 'closeTab') {
      const targetId = tabId || this.activeTabId;
      if (targetId && this.tabs.has(targetId)) {
        const tab = this.tabs.get(targetId);
        this.tabs.delete(targetId);
        this.destroyTabView(tab);
        if (this.activeTabId === targetId) {
          this.activeTabId = this.tabs.keys().next().value ?? null;
        }
        this.syncViews();
        this.emitState();
      }
      return this.uiSnapshot();
    }
    const active = tabId ? this.tabs.get(tabId) : (this.activeTabId ? this.tabs.get(this.activeTabId) : null);
    const wc = active?.view?.webContents;
    if (!wc || wc.isDestroyed()) return this.uiSnapshot();
    if (action === 'back') {
      if (canGoBackOf(wc)) {
        if (wc.navigationHistory?.goBack) wc.navigationHistory.goBack();
        else wc.goBack?.();
      }
    } else if (action === 'forward') {
      if (canGoForwardOf(wc)) {
        if (wc.navigationHistory?.goForward) wc.navigationHistory.goForward();
        else wc.goForward?.();
      }
    } else if (action === 'reload') {
      if (wc.isLoading()) wc.stop();
      else wc.reload();
    } else {
      const err = Error('INVALID_FIELDS');
      err.code = 'INVALID_FIELDS';
      throw err;
    }
    this.syncViews();
    const snap = this.uiSnapshot();
    this.emitState();
    return snap;
  }

  async handleAction(action, params = {}) {
    if (action === 'status') {
      return this.uiSnapshot();
    }
    if (action === 'listTabs') {
      return { tabs: this.describeTabs() };
    }
    if (action === 'newTab') {
      const tab = await this.createTab({ url: params.url || 'about:blank', show: Boolean(params.autoShow) });
      const info = this.describeTab(tab);
      return {
        id: tab.id,
        title: info?.title || '',
        url: info?.url || params.url || 'about:blank',
        active: true,
      };
    }
    if (action === 'selectTab') {
      const tab = await this.ensureTab(params.tabId, { show: Boolean(params.autoShow) });
      const info = this.describeTab(tab);
      return {
        id: tab.id,
        title: info?.title || '',
        url: info?.url || '',
        active: true,
      };
    }
    if (action === 'closeTab') {
      const tab = this.tabs.get(params.tabId);
      if (!tab) {
        const err = Error('BROWSER_TAB_NOT_FOUND');
        err.code = 'BROWSER_TAB_NOT_FOUND';
        throw err;
      }
      this.tabs.delete(params.tabId);
      this.destroyTabView(tab);
      if (this.activeTabId === params.tabId) {
        this.activeTabId = this.tabs.keys().next().value ?? null;
      }
      this.syncViews();
      this.emitState();
      return { closed: params.tabId };
    }
    if (action === 'show') {
      this.panelOpen = true;
      this.syncViews();
      const snap = this.uiSnapshot();
      this.emitState();
      return { ok: true, open: true, visible: snap.visible, tabId: snap.activeTabId };
    }
    if (action === 'hide') {
      this.panelOpen = false;
      this.syncViews();
      this.emitState();
      return { ok: true, open: false, visible: false };
    }
    if (action === 'reset') {
      for (const tab of [...this.tabs.values()]) {
        this.destroyTabView(tab);
      }
      this.tabs.clear();
      this.activeTabId = null;
      if (this.devSession) {
        await this.devSession.clearStorageData().catch(() => {});
        await this.devSession.clearCache().catch(() => {});
      }
      this.syncViews();
      this.emitState();
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
      const wc = tab.view.webContents;
      if (!tab.attached) {
        wc.debugger.attach('1.3');
        tab.attached = true;
      }
      if (params.method === 'Page.navigate' && !isAllowedDevUrl(params.params?.url)) {
        const err = Error('URL_SCHEME_DENIED');
        err.code = 'URL_SCHEME_DENIED';
        throw err;
      }
      if (!tab.lastVisible && (params.method === 'Page.captureScreenshot' || String(params.method || '').startsWith('Input.'))) {
        await this.ensureHiddenCompositor(tab);
      }
      const result = await wc.debugger.sendCommand(params.method, params.params || {});
      if (params.method === 'Page.navigate' || params.method === 'Page.reload' || params.method === 'Page.navigateToHistoryEntry') {
        this.syncViews();
        this.emitState();
      }
      return { tabId: tab.id, result: result ?? {} };
    }
    const err = Error('UNKNOWN_BUILTIN_ACTION');
    err.code = 'UNKNOWN_BUILTIN_ACTION';
    throw err;
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
      this.destroyTabView(tab);
    }
    this.tabs.clear();
    this.activeTabId = null;
    this.hostWin = null;
    if (this.server) {
      const s = this.server;
      this.server = null;
      s.closeAllConnections?.();
      await new Promise(resolve => s.close(resolve));
    }
  }
}

module.exports = { BuiltinBrowserBridge, isAllowedDevUrl, isRealPageUrl };
