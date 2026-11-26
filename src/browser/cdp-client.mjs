import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from '../execution/node_modules/ws/wrapper.mjs';
import { fail } from '../execution/protocol.mjs';
import { normalizeCdpUrl } from './settings.mjs';

export function httpGetJson(urlStr, { method = 'GET', timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { reject(Error('INVALID_CDP_URL')); return; }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method,
      timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    }, res => {
      const chunks = [];
      let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > 2 * 1024 * 1024) req.destroy(Error('CDP_RESPONSE_TOO_LARGE'));
        else chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          reject(Error(`CDP_HTTP_${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch { resolve({ raw: text }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Error('CDP_TIMEOUT')));
    req.end();
  });
}

export class CdpSession {
  constructor(wsUrl, { timeoutMs = 20000 } = {}) {
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, {
        handshakeTimeout: 6000,
        maxPayload: 32 * 1024 * 1024,
        perMessageDeflate: false,
      });
      this.ws = ws;
      let opened = false;
      ws.once('open', () => { opened = true; this.closed = false; resolve(); });
      ws.once('error', err => { if (!opened) reject(err); });
      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
        if (msg.id !== undefined) {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) {
            const e = Error(msg.error.message || `CDP error ${msg.error.code}`);
            e.cdpCode = msg.error.code;
            entry.reject(e);
          } else {
            entry.resolve(msg.result ?? {});
          }
          return;
        }
        if (msg.method) {
          const set = this.listeners.get(msg.method);
          if (set) {
            for (const fn of set) {
              try { fn(msg.params ?? {}, msg.sessionId); } catch {}
            }
          }
        }
      });
      ws.on('close', () => {
        this.closed = true;
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(Error('CDP_DISCONNECTED'));
        }
        this.pending.clear();
        const set = this.listeners.get('__close__');
        if (set) for (const fn of set) { try { fn(); } catch {} }
      });
    });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  send(method, params = {}, { sessionId, timeoutMs = this.timeoutMs } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(Error('CDP_NOT_CONNECTED'));
    }
    const id = ++this.nextId;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`CDP_TIMEOUT:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
    try { this.ws?.terminate(); } catch {}
    this.ws = null;
  }
}

function candidateActivePortFiles(platform = process.platform) {
  const home = homedir();
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(local, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'),
      join(local, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort'),
      join(local, 'Chromium', 'User Data', 'DevToolsActivePort'),
      join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'DevToolsActivePort'),
    ];
  }
  if (platform === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort'),
      join(home, 'Library', 'Application Support', 'Microsoft Edge', 'DevToolsActivePort'),
      join(home, 'Library', 'Application Support', 'Chromium', 'DevToolsActivePort'),
    ];
  }
  return [
    join(home, '.config', 'google-chrome', 'DevToolsActivePort'),
    join(home, '.config', 'chromium', 'DevToolsActivePort'),
    join(home, '.config', 'microsoft-edge', 'DevToolsActivePort'),
    join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'DevToolsActivePort'),
  ];
}

export function readDevToolsActivePorts(platform = process.platform) {
  const endpoints = [];
  for (const file of candidateActivePortFiles(platform)) {
    if (!existsSync(file)) continue;
    try {
      const [portLine] = readFileSync(file, 'utf8').trim().split(/\r?\n/);
      const port = Number(portLine?.trim());
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
        endpoints.push(`http://127.0.0.1:${port}`);
      }
    } catch {}
  }
  return endpoints;
}

export async function probeCdpHttp(baseUrl) {
  const version = await httpGetJson(`${baseUrl}/json/version`, { timeoutMs: 2500 });
  if (!version || typeof version !== 'object' || !version.webSocketDebuggerUrl) {
    throw Error('CDP_INVALID_VERSION');
  }
  const list = await httpGetJson(`${baseUrl}/json/list`, { timeoutMs: 2500 }).catch(() => []);
  const pages = Array.isArray(list)
    ? list.filter(item => item && item.type === 'page' && item.webSocketDebuggerUrl)
    : [];
  return {
    ok: true,
    httpEndpoint: baseUrl,
    browserWsUrl: version.webSocketDebuggerUrl,
    browser: version.Browser || 'Chromium',
    protocolVersion: version['Protocol-Version'] || '1.3',
    tabs: pages.map(p => ({
      id: p.id,
      title: p.title || '',
      url: p.url || '',
      wsUrl: p.webSocketDebuggerUrl,
    })),
  };
}

export async function discoverDailyBrowser(cdpUrl = 'auto', { stateDir = null } = {}) {
  const normalized = normalizeCdpUrl(cdpUrl);
  if (normalized.startsWith('ws://') || normalized.startsWith('wss://')) {
    const u = new URL(normalized);
    const httpBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
    try {
      return await probeCdpHttp(httpBase);
    } catch {
      return { ok: true, httpEndpoint: httpBase, browserWsUrl: normalized, browser: 'Custom CDP', protocolVersion: '1.3', tabs: [] };
    }
  }

  const candidates = [];
  if (normalized !== 'auto') {
    candidates.push(normalized);
  } else {
    candidates.push('http://127.0.0.1:9222', 'http://127.0.0.1:9223');
    for (const ep of readDevToolsActivePorts()) {
      if (!candidates.includes(ep)) candidates.push(ep);
    }
    if (stateDir) {
      const dedicated = join(stateDir, 'daily-chrome-profile', 'DevToolsActivePort');
      if (existsSync(dedicated)) {
        try {
          const [portLine] = readFileSync(dedicated, 'utf8').trim().split(/\r?\n/);
          const port = Number(portLine?.trim());
          if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
            const ep = `http://127.0.0.1:${port}`;
            if (!candidates.includes(ep)) candidates.unshift(ep);
          }
        } catch {}
      }
    }
  }

  let lastError = 'CDP_NOT_FOUND';
  for (const base of candidates) {
    try {
      return await probeCdpHttp(base);
    } catch (err) {
      lastError = err?.message || 'CDP_UNREACHABLE';
    }
  }
  return {
    ok: false,
    error: lastError,
    checked: candidates,
    hint: process.platform === 'win32'
      ? '请先以调试端口启动 Chrome/Edge（例如 chrome.exe --remote-debugging-port=9222），或点击「以调试模式启动浏览器」。'
      : '请先以调试端口启动 Chrome/Chromium（例如 google-chrome --remote-debugging-port=9222），或点击「以调试模式启动浏览器」。',
  };
}

export function findBrowserBinary(platform = process.platform) {
  if (process.env.ANYWHERE_BROWSER_BIN && existsSync(process.env.ANYWHERE_BROWSER_BIN)) {
    return process.env.ANYWHERE_BROWSER_BIN;
  }
  const candidates = platform === 'win32'
    ? [
        join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/microsoft-edge',
          '/usr/bin/brave-browser',
          '/snap/bin/chromium',
        ];
  return candidates.find(p => p && existsSync(p)) ?? null;
}

export async function launchDebugBrowser({ stateDir, port = 9222, headless = false, profileName = 'daily-chrome-profile' } = {}) {
  const bin = findBrowserBinary();
  if (!bin) fail('BROWSER_BINARY_NOT_FOUND');
  const userDataDir = join(stateDir || join(homedir(), '.anywhere-mesh'), profileName);
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    'about:blank',
  ];
  const child = spawn(bin, args, {
    detached: !headless,
    stdio: headless ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    windowsHide: headless,
  });
  if (!headless) child.unref();

  const deadline = Date.now() + 8000;
  let actualPort = port;
  const activePortFile = join(userDataDir, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    if (actualPort === 0 && existsSync(activePortFile)) {
      try {
        const [pLine] = readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
        const parsed = Number(pLine?.trim());
        if (Number.isInteger(parsed) && parsed > 0) actualPort = parsed;
      } catch {}
    }
    if (actualPort > 0) {
      try {
        const probed = await probeCdpHttp(`http://127.0.0.1:${actualPort}`);
        return { ...probed, pid: child.pid, child: headless ? child : null, binary: bin, userDataDir };
      } catch {}
    }
    await new Promise(r => setTimeout(r, 200));
  }
  if (headless) {
    try { child.kill('SIGKILL'); } catch {}
  }
  fail('BROWSER_LAUNCH_TIMEOUT');
}
