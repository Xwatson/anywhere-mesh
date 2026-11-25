import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function normalizeServerUrl(raw, { allowHttpLocalhost = false } = {}) {
  if (typeof raw !== 'string') throw Error('INVALID_SERVER_URL');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 255 || /[\s\0-\x1f\x7f]/.test(trimmed)) {
    throw Error('INVALID_SERVER_URL');
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw Error('INVALID_SERVER_URL');
  }
  const isLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  const schemeOk = u.protocol === 'https:' || (allowHttpLocalhost && u.protocol === 'http:' && isLocal);
  if (!schemeOk || !u.hostname || u.username || u.password || u.search || u.hash) {
    throw Error('INVALID_SERVER_URL');
  }
  if (u.pathname !== '/' && u.pathname !== '') {
    throw Error('INVALID_SERVER_URL');
  }
  return u.origin;
}

export function serverConfigPath(dataRoot) {
  return join(dataRoot, 'server.json');
}

export function loadSavedServerUrl(dataRoot) {
  if (!dataRoot) return null;
  try {
    const parsed = JSON.parse(readFileSync(serverConfigPath(dataRoot), 'utf8'));
    if (typeof parsed?.serverUrl !== 'string') return null;
    return normalizeServerUrl(parsed.serverUrl);
  } catch {
    return null;
  }
}

export function saveServerUrl(dataRoot, url) {
  const normalized = normalizeServerUrl(url);
  if (!dataRoot) return normalized;
  const file = serverConfigPath(dataRoot);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ serverUrl: normalized }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return normalized;
}

export function readDefaultServerUrl(appDir) {
  const envUrl = process.env.ANYWHERE_MESH_URL;
  if (typeof envUrl === 'string' && envUrl.trim()) {
    try { return normalizeServerUrl(envUrl); } catch {}
  }
  if (appDir) {
    try {
      const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
      if (typeof pkg?.defaultServerUrl === 'string' && pkg.defaultServerUrl.trim()) {
        return normalizeServerUrl(pkg.defaultServerUrl);
      }
    } catch {}
  }
  return null;
}
