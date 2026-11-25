import { createHash, createPublicKey, createPrivateKey, randomUUID, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import {
  chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync,
  mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const DEFAULT_UPDATE_BASE_URL = 'https://awc.xbxbe.com';
export const DEFAULT_UPDATE_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEASe+UuqTpJBN7o97l68uoARc5R/TERfZOj09hompXErM=',
  '-----END PUBLIC KEY-----',
  '',
].join('\n');

export const MANIFEST_DOMAIN_PREFIX = 'anywhere-mesh-update-v1\n';
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_BUNDLE_ARCHIVE_BYTES = 24 * 1024 * 1024;
export const MAX_BUNDLE_UNPACKED_BYTES = 48 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 2500;
export const MAX_FULL_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_FAILED_ATTEMPTS = 2;

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export function parseSemver(input) {
  if (typeof input !== 'string') return null;
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  const pre = m[4]
    ? m[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return {
    raw: input.trim(),
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
  };
}

export function isValidSemver(input) {
  return parseSemver(input) !== null;
}

export function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw Error('INVALID_SEMVER');
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const aNum = typeof ai === 'number';
    const bNum = typeof bi === 'number';
    if (aNum && bNum) return ai < bi ? -1 : 1;
    if (aNum) return -1;
    if (bNum) return 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalJson(item)).join(',') + ']';
  }
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function canonicalManifestBytes(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw Error('INVALID_MANIFEST');
  }
  const clean = { ...manifest };
  delete clean.signature;
  return Buffer.from(MANIFEST_DOMAIN_PREFIX + canonicalJson(clean), 'utf8');
}

export function signManifest(manifest, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  const payload = canonicalManifestBytes(manifest);
  const sig = cryptoSign(null, payload, key).toString('base64');
  return { ...manifest, signature: sig };
}

export function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  if (manifest.schemaVersion !== 1) return false;
  if (typeof manifest.channel !== 'string' || !/^[a-z0-9-]{1,32}$/.test(manifest.channel)) return false;
  if (!isValidSemver(manifest.version)) return false;
  if (manifest.publishedAt !== undefined && typeof manifest.publishedAt !== 'string') return false;
  if (manifest.notes !== undefined && (typeof manifest.notes !== 'string' || manifest.notes.length > 32768)) return false;
  if (!manifest.targets || typeof manifest.targets !== 'object' || Array.isArray(manifest.targets)) return false;
  for (const [platformKey, entry] of Object.entries(manifest.targets)) {
    if (!/^[a-z0-9-]+$/.test(platformKey) || !entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    for (const tier of ['bundle', 'full']) {
      if (entry[tier] === undefined) continue;
      const art = entry[tier];
      if (!art || typeof art !== 'object' || Array.isArray(art)) return false;
      if (typeof art.url !== 'string' || !art.url.trim() || art.url.length > 512) return false;
      if (typeof art.sha256 !== 'string' || !SHA256_RE.test(art.sha256)) return false;
      if (!Number.isSafeInteger(art.size) || art.size <= 0 || art.size > MAX_FULL_ARTIFACT_BYTES) return false;
      if (tier === 'bundle' && (typeof art.runtimeAbi !== 'string' || !art.runtimeAbi.trim() || art.runtimeAbi.length > 128)) return false;
      if (tier === 'full' && !['nsis', 'linux-tar'].includes(art.kind)) return false;
    }
  }
  return true;
}

export function verifyManifestSignature(manifest, publicKeyPem = DEFAULT_UPDATE_PUBLIC_KEY) {
  if (!validateManifestShape(manifest)) return false;
  if (typeof manifest.signature !== 'string' || !manifest.signature.trim()) return false;
  let sigBytes;
  try {
    sigBytes = Buffer.from(manifest.signature, 'base64');
    if (sigBytes.length !== 64) return false;
    const key = createPublicKey(publicKeyPem);
    const payload = canonicalManifestBytes(manifest);
    return cryptoVerify(null, payload, key, sigBytes);
  } catch {
    return false;
  }
}

export function isLocalhostHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

export function resolveSafeArtifactUrl(baseUrl, artifactUrl, { allowHttpLocalhost = false } = {}) {
  const base = new URL(baseUrl);
  const resolved = new URL(artifactUrl, base);
  const baseOk = base.protocol === 'https:' || (allowHttpLocalhost && base.protocol === 'http:' && isLocalhostHost(base.hostname));
  if (!baseOk) throw Error('INSECURE_UPDATE_URL');
  const targetOk = resolved.protocol === 'https:' || (allowHttpLocalhost && resolved.protocol === 'http:' && isLocalhostHost(resolved.hostname));
  if (!targetOk) throw Error('INSECURE_UPDATE_URL');
  if (resolved.origin !== base.origin) throw Error('UNTRUSTED_UPDATE_ORIGIN');
  if (resolved.username || resolved.password) throw Error('INVALID_UPDATE_URL');
  return resolved;
}

export function platformKeyFor(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function readInstalledMeta(appDir) {
  try {
    const raw = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
    const version = typeof raw?.version === 'string' && isValidSemver(raw.version) ? raw.version.trim() : null;
    const runtimeAbi = typeof raw?.runtimeAbi === 'string' && raw.runtimeAbi.trim() ? raw.runtimeAbi.trim() : null;
    return { version, runtimeAbi };
  } catch {
    return { version: null, runtimeAbi: null };
  }
}

export function selectUpdateArtifact(manifest, {
  currentVersion,
  platformKey = platformKeyFor(),
  runtimeAbi = null,
  failedVersions = {},
  ignoreFailures = false,
} = {}) {
  if (!validateManifestShape(manifest)) throw Error('INVALID_MANIFEST');
  if (!isValidSemver(currentVersion)) throw Error('INVALID_CURRENT_VERSION');

  if (compareVersions(manifest.version, currentVersion) <= 0) {
    return { available: false, upToDate: true, latestVersion: manifest.version };
  }

  const target = manifest.targets[platformKey];
  if (!target) {
    return { available: false, incompatible: true, reason: 'PLATFORM_UNSUPPORTED', latestVersion: manifest.version };
  }

  const failure = failedVersions?.[manifest.version];
  const blockedByFailure = !ignoreFailures && Boolean(failure && failure.count >= MAX_FAILED_ATTEMPTS);

  let mode = null;
  let artifact = null;
  if (target.bundle && runtimeAbi && target.bundle.runtimeAbi === runtimeAbi) {
    mode = 'bundle';
    artifact = target.bundle;
  } else if (target.full) {
    mode = 'full';
    artifact = target.full;
  } else {
    return {
      available: false,
      incompatible: true,
      reason: 'RUNTIME_ABI_MISMATCH',
      latestVersion: manifest.version,
    };
  }

  return {
    available: true,
    upToDate: false,
    version: manifest.version,
    publishedAt: manifest.publishedAt ?? null,
    notes: manifest.notes ?? '',
    channel: manifest.channel,
    mode,
    kind: mode === 'bundle' ? 'app-bundle' : artifact.kind,
    artifact,
    blockedByFailure,
    lastFailure: failure ?? null,
  };
}

export function defaultUpdateState() {
  return {
    autoCheck: true,
    autoDownload: true,
    installOnQuit: true,
    channel: 'stable',
    lastCheckedAt: null,
    dismissedVersion: null,
    pendingInstall: null,
    appliedAttempt: null,
    lastUpdatedTo: null,
    lastRollback: null,
    failedVersions: {},
  };
}

export function loadUpdateState(stateFile) {
  const base = defaultUpdateState();
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
    return {
      ...base,
      autoCheck: typeof parsed.autoCheck === 'boolean' ? parsed.autoCheck : base.autoCheck,
      autoDownload: typeof parsed.autoDownload === 'boolean' ? parsed.autoDownload : base.autoDownload,
      installOnQuit: typeof parsed.installOnQuit === 'boolean' ? parsed.installOnQuit : base.installOnQuit,
      channel: typeof parsed.channel === 'string' && /^[a-z0-9-]{1,32}$/.test(parsed.channel) ? parsed.channel : base.channel,
      lastCheckedAt: Number.isSafeInteger(parsed.lastCheckedAt) ? parsed.lastCheckedAt : null,
      dismissedVersion: typeof parsed.dismissedVersion === 'string' && isValidSemver(parsed.dismissedVersion) ? parsed.dismissedVersion : null,
      pendingInstall: parsed.pendingInstall && typeof parsed.pendingInstall === 'object' ? parsed.pendingInstall : null,
      appliedAttempt: parsed.appliedAttempt && typeof parsed.appliedAttempt === 'object' ? parsed.appliedAttempt : null,
      lastUpdatedTo: parsed.lastUpdatedTo && typeof parsed.lastUpdatedTo === 'object' ? parsed.lastUpdatedTo : null,
      lastRollback: parsed.lastRollback && typeof parsed.lastRollback === 'object' ? parsed.lastRollback : null,
      failedVersions: parsed.failedVersions && typeof parsed.failedVersions === 'object' && !Array.isArray(parsed.failedVersions)
        ? parsed.failedVersions : {},
    };
  } catch {
    return base;
  }
}

export function saveUpdateState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const tmp = `${stateFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, stateFile);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function computeFileSha256(filePath) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', rejectHash);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function httpGetRaw(url, { tls = {}, timeoutMs = 20000, signal, allowHttpLocalhost = false, redirectDepth = 0 }) {
  return new Promise((resolveRes, rejectRes) => {
    const parsed = url instanceof URL ? url : new URL(url);
    const isHttps = parsed.protocol === 'https:';
    if (!isHttps && !(allowHttpLocalhost && parsed.protocol === 'http:' && isLocalhostHost(parsed.hostname))) {
      rejectRes(Error('INSECURE_UPDATE_URL'));
      return;
    }
    const mod = isHttps ? https : http;
    const reqOpts = {
      method: 'GET',
      timeout: timeoutMs,
      signal,
      headers: {
        'User-Agent': 'AnywhereMesh-Updater/1',
        'Accept': '*/*',
        'Cache-Control': 'no-cache',
      },
      ...(isHttps ? { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...tls } : {}),
    };
    const req = mod.request(parsed, reqOpts, res => {
      const code = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        if (redirectDepth >= 3) {
          rejectRes(Error('UPDATE_TOO_MANY_REDIRECTS'));
          return;
        }
        try {
          const next = resolveSafeArtifactUrl(parsed.href, res.headers.location, { allowHttpLocalhost });
          resolveRes(httpGetRaw(next, { tls, timeoutMs, signal, allowHttpLocalhost, redirectDepth: redirectDepth + 1 }));
        } catch (err) {
          rejectRes(err);
        }
        return;
      }
      resolveRes({ req, res, url: parsed });
    });
    req.on('timeout', () => req.destroy(Error('UPDATE_NETWORK_TIMEOUT')));
    req.on('error', err => rejectRes(signal?.aborted ? Error('UPDATE_CANCELLED') : err));
    req.end();
  });
}

export async function fetchManifest(baseUrl = DEFAULT_UPDATE_BASE_URL, {
  manifestPath = '/updates/manifest.json',
  publicKeyPem = DEFAULT_UPDATE_PUBLIC_KEY,
  tls = {},
  timeoutMs = 15000,
  signal,
  allowHttpLocalhost = false,
} = {}) {
  const url = resolveSafeArtifactUrl(baseUrl, manifestPath, { allowHttpLocalhost });
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const { req, res } = await httpGetRaw(url, { tls, timeoutMs, signal: combined, allowHttpLocalhost });
  const chunks = [];
  let total = 0;
  try {
    await new Promise((resolveEnd, rejectEnd) => {
      res.on('error', rejectEnd);
      res.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_MANIFEST_BYTES) {
          req.destroy(Error('UPDATE_MANIFEST_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', resolveEnd);
    });
  } catch (err) {
    if (deadline.aborted && !signal?.aborted) throw Error('UPDATE_NETWORK_TIMEOUT');
    if (signal?.aborted) throw Error('UPDATE_CANCELLED');
    throw err;
  }
  if (res.statusCode === 404) throw Error('UPDATE_NOT_AVAILABLE');
  if (res.statusCode !== 200) throw Error('UPDATE_HTTP_' + res.statusCode);
  let manifest;
  try {
    manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Error('INVALID_MANIFEST');
  }
  if (!verifyManifestSignature(manifest, publicKeyPem)) {
    throw Error('UPDATE_SIGNATURE_INVALID');
  }
  return manifest;
}

export async function downloadVerified(url, destFile, {
  expectedSha256,
  expectedSize,
  tls = {},
  maxBytes = MAX_FULL_ARTIFACT_BYTES,
  idleTimeoutMs = 30000,
  onProgress = null,
  signal,
  allowHttpLocalhost = false,
} = {}) {
  if (!SHA256_RE.test(expectedSha256 ?? '')) throw Error('INVALID_CHECKSUM');
  mkdirSync(dirname(destFile), { recursive: true, mode: 0o700 });

  if (existsSync(destFile)) {
    try {
      const st = statSync(destFile);
      if (st.isFile() && (!expectedSize || st.size === expectedSize)) {
        const existingHash = await computeFileSha256(destFile);
        if (existingHash === expectedSha256) {
          onProgress?.({ downloadedBytes: st.size, totalBytes: st.size, percent: 100, speedBps: 0 });
          return { path: destFile, size: st.size, sha256: existingHash, reused: true };
        }
      }
    } catch {}
  }

  const partFile = `${destFile}.${randomUUID()}.part`;
  const { req, res } = await httpGetRaw(url, { tls, timeoutMs: idleTimeoutMs, signal, allowHttpLocalhost });
  if (res.statusCode !== 200) {
    res.resume();
    throw Error('UPDATE_HTTP_' + res.statusCode);
  }
  const headerLen = Number(res.headers['content-length']);
  const totalBytes = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : (expectedSize ?? 0);
  if (expectedSize && Number.isFinite(headerLen) && headerLen > 0 && headerLen !== expectedSize) {
    res.resume();
    throw Error('UPDATE_SIZE_MISMATCH');
  }
  if (totalBytes > maxBytes) {
    res.resume();
    throw Error('UPDATE_ARTIFACT_TOO_LARGE');
  }

  const hash = createHash('sha256');
  const out = createWriteStream(partFile, { flags: 'wx', mode: 0o600 });
  let downloaded = 0;
  const startedAt = Date.now();
  let lastReportAt = 0;

  const emitProgress = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReportAt < 120) return;
    lastReportAt = now;
    const elapsedSec = Math.max(0.05, (now - startedAt) / 1000);
    const speedBps = Math.round(downloaded / elapsedSec);
    const percent = totalBytes > 0 ? Math.min(100, Math.round((downloaded / totalBytes) * 100)) : 0;
    onProgress({ downloadedBytes: downloaded, totalBytes, percent, speedBps });
  };

  try {
    await new Promise((resolvePipe, rejectPipe) => {
      let settled = false;
      const fail = err => {
        if (settled) return;
        settled = true;
        req.destroy();
        out.destroy();
        rejectPipe(signal?.aborted ? Error('UPDATE_CANCELLED') : err);
      };
      if (signal) {
        signal.addEventListener('abort', () => fail(Error('UPDATE_CANCELLED')), { once: true });
      }
      out.on('error', fail);
      res.on('error', fail);
      res.on('aborted', () => fail(Error('UPDATE_DOWNLOAD_INTERRUPTED')));
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (downloaded > maxBytes || (expectedSize && downloaded > expectedSize)) {
          fail(Error('UPDATE_SIZE_MISMATCH'));
          return;
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          res.pause();
          out.once('drain', () => res.resume());
        }
        emitProgress(false);
      });
      res.on('end', () => {
        out.end(() => {
          if (!settled) {
            settled = true;
            resolvePipe();
          }
        });
      });
    });

    if (expectedSize && downloaded !== expectedSize) throw Error('UPDATE_SIZE_MISMATCH');
    const actualSha = hash.digest('hex');
    if (actualSha !== expectedSha256) throw Error('UPDATE_CHECKSUM_MISMATCH');
    emitProgress(true);
    renameSync(partFile, destFile);
    return { path: destFile, size: downloaded, sha256: actualSha, reused: false };
  } catch (err) {
    rmSync(partFile, { force: true });
    throw err;
  }
}

function readNullTerminated(buf, start, end) {
  let i = start;
  while (i < end && buf[i] !== 0) i++;
  return buf.subarray(start, i).toString('utf8');
}

function parseTarNumber(buf, start, len) {
  if (buf[start] & 0x80) {
    let val = 0n;
    for (let i = 1; i < len; i++) {
      val = (val << 8n) | BigInt(buf[start + i]);
    }
    return Number(val);
  }
  const str = readNullTerminated(buf, start, start + len).trim();
  if (!str) return 0;
  const parsed = parseInt(str, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw Error('INVALID_TAR_HEADER');
  return parsed;
}

function verifyTarChecksum(block) {
  const expected = parseTarNumber(block, 148, 8);
  let unsignedSum = 0;
  let signedSum = 0;
  for (let i = 0; i < 512; i++) {
    const b = (i >= 148 && i < 156) ? 32 : block[i];
    unsignedSum += b;
    signedSum += b < 128 ? b : b - 256;
  }
  return expected === unsignedSum || expected === signedSum;
}

function parsePaxRecords(buf) {
  const out = {};
  let offset = 0;
  while (offset < buf.length) {
    const sp = buf.indexOf(0x20, offset);
    if (sp < 0) break;
    const len = parseInt(buf.subarray(offset, sp).toString('ascii'), 10);
    if (!Number.isInteger(len) || len <= 0 || offset + len > buf.length) break;
    const line = buf.subarray(sp + 1, offset + len - 1).toString('utf8');
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    offset += len;
  }
  return out;
}

function sanitizeTarEntryPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0') || rawPath.includes('\\')) {
    throw Error('UNSAFE_ARCHIVE_PATH');
  }
  if (/^[A-Za-z]:/.test(rawPath) || rawPath.startsWith('/')) {
    throw Error('UNSAFE_ARCHIVE_PATH');
  }
  const trimmed = rawPath.replace(/\/+$/, '');
  if (!trimmed || trimmed === '.') return '';
  const normalized = posix.normalize(trimmed);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw Error('UNSAFE_ARCHIVE_PATH');
  }
  const parts = normalized.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) {
    throw Error('UNSAFE_ARCHIVE_PATH');
  }
  return normalized;
}

export function extractTarGzStrict(gzBuffer, destDir, {
  maxUnpackedBytes = MAX_BUNDLE_UNPACKED_BYTES,
  maxFiles = MAX_BUNDLE_FILES,
} = {}) {
  let tar;
  try {
    tar = gunzipSync(gzBuffer, { maxOutputLength: maxUnpackedBytes + 4 * 1024 * 1024 });
  } catch {
    throw Error('INVALID_ARCHIVE_GZIP');
  }
  if (tar.length % 512 !== 0) throw Error('INVALID_TAR_SIZE');

  const root = resolve(destDir);
  mkdirSync(root, { recursive: true, mode: 0o755 });

  let offset = 0;
  let totalBytes = 0;
  let fileCount = 0;
  let nextPax = null;
  let globalPax = {};
  let nextGnuLongName = null;
  const extractedFiles = [];

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;

    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    if (!verifyTarChecksum(header)) throw Error('INVALID_TAR_CHECKSUM');

    const typeByte = header[156];
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const mode = parseTarNumber(header, 100, 8);
    let size = parseTarNumber(header, 124, 12);
    const prefix = readNullTerminated(header, 345, 500);
    const baseName = readNullTerminated(header, 0, 100);
    let name = prefix ? `${prefix}/${baseName}` : baseName;

    const mergedPax = { ...globalPax, ...(nextPax ?? {}) };
    if (nextGnuLongName) name = nextGnuLongName;
    if (mergedPax.path) name = mergedPax.path;
    if (mergedPax.size !== undefined) {
      const paxSize = Number(mergedPax.size);
      if (!Number.isSafeInteger(paxSize) || paxSize < 0) throw Error('INVALID_TAR_HEADER');
      size = paxSize;
    }

    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tar.length) throw Error('TRUNCATED_TAR_ENTRY');
    const data = tar.subarray(offset, offset + size);
    offset += paddedSize;

    if (type === 'x') {
      nextPax = parsePaxRecords(data);
      continue;
    }
    if (type === 'g') {
      globalPax = { ...globalPax, ...parsePaxRecords(data) };
      continue;
    }
    if (type === 'L') {
      nextGnuLongName = readNullTerminated(data, 0, data.length);
      continue;
    }
    nextPax = null;
    nextGnuLongName = null;

    const safeRel = sanitizeTarEntryPath(name);
    if (!safeRel) continue;

    const target = resolve(root, ...safeRel.split('/'));
    if (target !== root && !target.startsWith(root + sep)) {
      throw Error('UNSAFE_ARCHIVE_PATH');
    }

    if (type === '5') {
      mkdirSync(target, { recursive: true, mode: 0o755 });
      continue;
    }
    if (type !== '0') {
      throw Error('UNSUPPORTED_ARCHIVE_ENTRY_TYPE');
    }

    fileCount++;
    if (fileCount > maxFiles) throw Error('ARCHIVE_FILE_LIMIT');
    totalBytes += size;
    if (totalBytes > maxUnpackedBytes) throw Error('ARCHIVE_SIZE_LIMIT');

    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    const fileMode = (mode & 0o111) ? 0o755 : 0o644;
    writeFileSync(target, data, { mode: fileMode });
    if (process.platform !== 'win32') {
      try { chmodSync(target, fileMode); } catch {}
    }
    extractedFiles.push(safeRel);
  }

  return { fileCount, totalBytes, files: extractedFiles };
}

function writeOctal(buf, offset, length, value) {
  const str = value.toString(8).padStart(length - 1, '0');
  if (str.length > length - 1) throw Error('TAR_FIELD_OVERFLOW');
  buf.write(str, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function buildTarHeader(name, size, mode, typeFlag) {
  const header = Buffer.alloc(512, 0);
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length <= 100) {
    nameBytes.copy(header, 0);
  } else {
    const slash = name.lastIndexOf('/');
    const prefix = slash > 0 ? name.slice(0, slash) : '';
    const base = slash > 0 ? name.slice(slash + 1) : name;
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) {
      throw Error('TAR_PATH_TOO_LONG');
    }
    header.write(base, 0, 100, 'utf8');
    header.write(prefix, 345, 155, 'utf8');
  }
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = typeFlag.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

export function createTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '', 'utf8');
    const mode = entry.mode ?? 0o644;
    const type = entry.type ?? '0';
    const nameBytes = Buffer.from(entry.name, 'utf8');
    if (nameBytes.length > 100) {
      const body = `path=${entry.name}\n`;
      let recLen = Buffer.byteLength(body) + 2;
      while (String(recLen).length + 1 + Buffer.byteLength(body) !== recLen) {
        recLen = String(recLen).length + 1 + Buffer.byteLength(body);
      }
      const paxBuf = Buffer.from(`${recLen} ${body}`, 'utf8');
      blocks.push(buildTarHeader('PaxHeaders/entry', paxBuf.length, 0o644, 'x'));
      blocks.push(paxBuf);
      const paxPad = (512 - (paxBuf.length % 512)) % 512;
      if (paxPad) blocks.push(Buffer.alloc(paxPad, 0));
      blocks.push(buildTarHeader(entry.name.slice(-90), data.length, mode, type));
    } else {
      blocks.push(buildTarHeader(entry.name, data.length, mode, type));
    }
    if (data.length > 0) {
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from, to, retries = 12, delayMs = 250) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (i === retries || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleepSync(delayMs);
    }
  }
  throw lastErr;
}

export const WINDOWS_PRESERVED_HELPERS = [
  'src/account-devices/windows/WorkspaceSnapshot.exe',
  'src/account-devices/windows/PeerHost.exe',
  'src/account-devices/windows/TaskHost.exe',
  'src/account-devices/windows/LoginProtection.exe',
];

export async function applyBundleUpdate({
  archivePath,
  expectedSha256,
  targetVersion,
  appDir,
  backupDir = appDir + '.prev',
  preserveRelPaths = process.platform === 'win32' ? WINDOWS_PRESERVED_HELPERS : [],
} = {}) {
  const actualHash = await computeFileSha256(archivePath);
  if (actualHash !== expectedSha256) throw Error('UPDATE_CHECKSUM_MISMATCH');

  const resolvedApp = resolve(appDir);
  const resolvedBackup = resolve(backupDir);
  const stagingDir = `${resolvedApp}.next.${randomUUID().slice(0, 8)}`;

  try {
    const gzBytes = readFileSync(archivePath);
    extractTarGzStrict(gzBytes, stagingDir);

    const stagedMeta = readInstalledMeta(stagingDir);
    if (!stagedMeta.version || stagedMeta.version !== targetVersion) {
      throw Error('UPDATE_VERSION_MISMATCH');
    }
    if (!existsSync(join(stagingDir, 'src/desktop/main.cjs'))) {
      throw Error('UPDATE_BUNDLE_INCOMPLETE');
    }

    for (const rel of preserveRelPaths) {
      const dst = join(stagingDir, ...rel.split('/'));
      if (existsSync(dst)) continue;
      const src = join(resolvedApp, ...rel.split('/'));
      if (!existsSync(src)) throw Error('MISSING_PRESERVED_HELPER:' + rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }

    if (existsSync(resolvedBackup)) {
      rmSync(resolvedBackup, { recursive: true, force: true });
    }

    renameWithRetry(resolvedApp, resolvedBackup);
    try {
      renameWithRetry(stagingDir, resolvedApp);
    } catch (swapErr) {
      try { renameWithRetry(resolvedBackup, resolvedApp); } catch {}
      throw swapErr;
    }

    return { ok: true, version: stagedMeta.version, runtimeAbi: stagedMeta.runtimeAbi, backupDir: resolvedBackup };
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

export function rollbackBundleUpdate({ appDir, backupDir = appDir + '.prev' }) {
  const resolvedApp = resolve(appDir);
  const resolvedBackup = resolve(backupDir);
  if (!existsSync(resolvedBackup)) return false;
  const brokenDir = `${resolvedApp}.broken.${Date.now()}`;
  try {
    if (existsSync(resolvedApp)) {
      renameWithRetry(resolvedApp, brokenDir, 6, 200);
    }
    renameWithRetry(resolvedBackup, resolvedApp, 6, 200);
    rmSync(brokenDir, { recursive: true, force: true });
    return true;
  } catch {
    if (!existsSync(resolvedApp) && existsSync(brokenDir)) {
      try { renameSync(brokenDir, resolvedApp); } catch {}
    }
    return false;
  }
}

export function cleanupOldCacheFiles(cacheDir, keepPaths = []) {
  if (!existsSync(cacheDir)) return;
  const keep = new Set(keepPaths.filter(Boolean).map(p => resolve(p)));
  for (const name of readdirSync(cacheDir)) {
    const full = resolve(cacheDir, name);
    if (keep.has(full)) continue;
    try { rmSync(full, { recursive: true, force: true }); } catch {}
  }
}

export function isAbsoluteSafe(p) {
  return typeof p === 'string' && isAbsolute(p) && !p.includes('\0');
}
