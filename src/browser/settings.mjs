import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail } from '../execution/protocol.mjs';

export const DEFAULT_BROWSER_SETTINGS = Object.freeze({
  builtin: Object.freeze({
    enabled: false,
    autoShow: false,
  }),
  daily: Object.freeze({
    enabled: false,
    access: 'full', // 'full' | 'read'
    backend: 'cdp', // 'cdp' | 'chrome-devtools-mcp' | 'playwright-mcp'
    cdpUrl: 'auto', // 'auto' | loopback http(s):// or ws(s):// URL
  }),
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const VALID_ACCESS = new Set(['full', 'read']);
const VALID_BACKENDS = new Set(['cdp', 'chrome-devtools-mcp', 'playwright-mcp']);

export function normalizeCdpUrl(raw) {
  if (raw === undefined || raw === null) return 'auto';
  if (typeof raw !== 'string') fail('INVALID_CDP_URL');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'auto') return 'auto';
  if (/^\d{2,5}$/.test(trimmed)) {
    const port = Number(trimmed);
    if (port < 1024 || port > 65535) fail('INVALID_CDP_URL');
    return `http://127.0.0.1:${port}`;
  }
  let u;
  try { u = new URL(trimmed); } catch { fail('INVALID_CDP_URL'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) fail('INVALID_CDP_URL');
  if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) fail('CDP_LOOPBACK_REQUIRED');
  if (u.username || u.password) fail('INVALID_CDP_URL');
  return u.href.replace(/\/+$/, '');
}

export function normalizeBrowserSettings(input, base = DEFAULT_BROWSER_SETTINGS) {
  const cur = base ?? DEFAULT_BROWSER_SETTINGS;
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const bIn = src.builtin && typeof src.builtin === 'object' && !Array.isArray(src.builtin) ? src.builtin : {};
  const dIn = src.daily && typeof src.daily === 'object' && !Array.isArray(src.daily) ? src.daily : {};

  const builtinEnabled = typeof bIn.enabled === 'boolean' ? bIn.enabled : Boolean(cur.builtin?.enabled);
  const builtinAutoShow = typeof bIn.autoShow === 'boolean' ? bIn.autoShow : (cur.builtin?.autoShow ?? false);
  const dailyEnabled = typeof dIn.enabled === 'boolean' ? dIn.enabled : Boolean(cur.daily?.enabled);
  const dailyAccess = dIn.access !== undefined ? String(dIn.access) : (cur.daily?.access ?? 'full');
  if (!VALID_ACCESS.has(dailyAccess)) fail('INVALID_BROWSER_ACCESS');
  const dailyBackend = dIn.backend !== undefined ? String(dIn.backend) : (cur.daily?.backend ?? 'cdp');
  if (!VALID_BACKENDS.has(dailyBackend)) fail('INVALID_BROWSER_BACKEND');
  const dailyCdpUrl = dIn.cdpUrl !== undefined ? normalizeCdpUrl(dIn.cdpUrl) : normalizeCdpUrl(cur.daily?.cdpUrl ?? 'auto');

  return {
    builtin: {
      enabled: builtinEnabled,
      autoShow: builtinAutoShow,
    },
    daily: {
      enabled: dailyEnabled,
      access: dailyAccess,
      backend: dailyBackend,
      cdpUrl: dailyCdpUrl,
    },
  };
}

export class BrowserSettingsStore {
  constructor(stateDir, { initial = null, onChange = null } = {}) {
    this.file = stateDir ? join(stateDir, 'browser-settings.json') : null;
    this.onChange = onChange;
    this.current = initial
      ? normalizeBrowserSettings(initial)
      : this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return normalizeBrowserSettings({});
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      return normalizeBrowserSettings(parsed);
    } catch {
      return normalizeBrowserSettings({});
    }
  }

  get() {
    return structuredClone(this.current);
  }

  update(patch) {
    const prev = this.current;
    const next = normalizeBrowserSettings(patch, prev);
    this.current = next;
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(tmp, this.file);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    this.onChange?.(next, prev);
    return this.get();
  }
}
