import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { applyHunks, parsePatch } from '../workspace/patch.mjs';
import { WORKSPACE_CATALOG, PROCESS_TOOL_NAMES } from '../workspace/catalog.mjs';
import { BackgroundProcessManager } from '../workspace/bg-processes.mjs';

const execFileAsync = promisify(execFile);

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 10000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const IMAGE_MIMES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};
const BASE_TOOLS = [...WORKSPACE_CATALOG.map(t => t.name), ...PROCESS_TOOL_NAMES];
const BG_READ_TOOLS = new Set(['bg_list', 'bg_output']);
const BG_WRITE_TOOLS = new Set(['bg_start', 'bg_input', 'bg_stop']);
const BROWSER_READ_TOOLS = new Set(['browser_status', 'browser_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_logs', 'browser_wait']);
const BROWSER_WRITE_TOOLS = new Set(['browser_navigate', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_eval', 'browser_tab_action']);

let rgAvailable = null;
function hasRipgrep() {
  if (rgAvailable !== null) return rgAvailable;
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore', timeout: 2000 });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

const fail = code => { const e = Error(code); e.code = code; throw e; };
const revisionOf = bytes => 'file-v1:' + createHash('sha256').update(bytes).digest('hex');

const MAC_VOLUME_CACHE_TTL_MS = 30000;
const macVolumeUuidCache = new Map();

export function parseDfDevice(output) {
  if (typeof output !== 'string') return null;
  const lines = output.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const line = lines[lines.length - 1].trim();
  const device = line.split(/\s+/)[0] ?? '';
  return device.startsWith('/dev/') ? device : null;
}

export function parseDiskutilVolumeUuid(plistXml) {
  if (typeof plistXml !== 'string') return null;
  for (const key of ['VolumeUUID', 'FilesystemUUID', 'DiskUUID']) {
    const re = new RegExp(`<key>${key}</key>\\s*<string>\\s*([A-Fa-f0-9-]{8,64})\\s*</string>`);
    const match = re.exec(plistXml);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

export function resolveMacVolumeUuid(
  path,
  devKey = null,
  { execSyncFn = execFileSync, cache = macVolumeUuidCache, now = Date.now } = {},
) {
  const key = devKey === null ? null : String(devKey);
  const cached = key !== null ? cache.get(key) : null;
  if (cached && now() - cached.checkedAt < MAC_VOLUME_CACHE_TTL_MS) return cached.uuid;
  let device = null;
  try {
    const dfOut = execSyncFn('/bin/df', ['-P', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    device = parseDfDevice(dfOut);
  } catch {
    return cached?.uuid ?? null;
  }
  if (!device) return cached?.uuid ?? null;
  let uuid = null;
  try {
    const plist = execSyncFn('/usr/sbin/diskutil', ['info', '-plist', device], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    uuid = parseDiskutilVolumeUuid(plist);
  } catch {
    return cached?.uuid ?? null;
  }
  if (!uuid) return cached?.uuid ?? null;
  if (key !== null) cache.set(key, { uuid, checkedAt: now() });
  return uuid;
}

export function canMigrateLegacyRootIdentity(savedIdentity, currentIdentity) {
  if (typeof savedIdentity !== 'string' || typeof currentIdentity !== 'string') return false;
  const legacy = /^\d+:(\d+)$/.exec(savedIdentity);
  const modern = /^vol:[A-Za-z0-9-]+:(\d+)$/.exec(currentIdentity);
  return Boolean(legacy && modern && legacy[1] === modern[1]);
}

export function identifyLinuxRoot(
  path,
  { platform = process.platform, resolveVolumeUuid = resolveMacVolumeUuid } = {},
) {
  const st = statSync(path, { bigint: true });
  if (realpathSync(path) !== path || !st.isDirectory()) fail('WORKSPACE_ROOT_CHANGED');
  if (platform === 'darwin') {
    const volUuid = resolveVolumeUuid(path, st.dev);
    if (volUuid) return 'vol:' + volUuid + ':' + st.ino.toString();
  }
  return st.dev.toString() + ':' + st.ino.toString();
}

function assertRoot(root, rootIdentity) {
  if (identifyLinuxRoot(root) !== rootIdentity) fail('WORKSPACE_ROOT_CHANGED');
}

function segmentsOf(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.includes('\\') || rel.includes(':') || /[\x00-\x1f]/.test(rel)) {
    fail('PATH_DENIED');
  }
  if (rel === '.') return [];
  const segs = rel.split('/');
  if (segs.some(s => !s || s === '.' || s === '..')) fail('PATH_DENIED');
  return segs;
}

function resolveNoSymlink(root, rel, { allowMissingLeaf = false, allowMissingParents = false } = {}) {
  const segs = segmentsOf(rel);
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    const next = join(cur, segs[i]);
    const isLeaf = i === segs.length - 1;
    let st;
    try { st = lstatSync(next); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (isLeaf && allowMissingLeaf) return { fullPath: next, stat: null };
      if (allowMissingParents) return { fullPath: resolve(root, ...segs), stat: null };
      fail('FILE_NOT_FOUND');
    }
    if (st.isSymbolicLink()) fail('SYMLINK_DENIED');
    if (!isLeaf && !st.isDirectory()) fail('NOT_A_DIRECTORY');
    cur = next;
  }
  return { fullPath: cur, stat: lstatSync(cur) };
}

function checkRevision(fullPath, stat, expectedRevision) {
  if (expectedRevision === undefined) return;
  if (expectedRevision === null) {
    if (stat) fail('FILE_EXISTS');
    return;
  }
  if (!stat || !stat.isFile()) fail('FILE_REVISION_CONFLICT');
  const current = revisionOf(readFileSync(fullPath));
  if (current !== expectedRevision) fail('FILE_REVISION_CONFLICT');
}

function atomicWrite(fullPath, contentBytes) {
  mkdirSync(dirname(fullPath), { recursive: true });
  const tmp = `${fullPath}.anywhere-${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, contentBytes, { flag: 'wx' });
    renameSync(tmp, fullPath);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

function readOneFile(root, rel, offset = 0, length = 200) {
  const { fullPath, stat } = resolveNoSymlink(root, rel);
  if (!stat.isFile()) fail('NOT_A_FILE');
  const mime = IMAGE_MIMES[extname(rel).toLowerCase()];
  if (mime) {
    if (stat.size > MAX_IMAGE_BYTES) fail('FILE_TOO_LARGE');
    const bytes = readFileSync(fullPath);
    const rev = revisionOf(bytes);
    return {
      content: [
        { type: 'image', data: bytes.toString('base64'), mimeType: mime },
        { type: 'text', text: `Image file ${rel} (${mime}, ${bytes.length} bytes, revision: ${rev})` },
      ],
      fileVersions: [{ path: rel, revision: rev, size: bytes.length }],
    };
  }
  if (stat.size > MAX_READ_BYTES) fail('FILE_TOO_LARGE');
  const bytes = readFileSync(fullPath);
  if (bytes.subarray(0, 8192).includes(0)) fail('BINARY_FILE');
  const rev = revisionOf(bytes);
  const text = bytes.toString('utf8');
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
  const total = lines.length;
  let start = offset >= 0 ? offset : Math.max(0, total + offset);
  const slice = lines.slice(start, start + length);
  const body = slice.map((l, idx) => `${start + idx + 1}\t${l}`).join('\n');
  const footer = `--- ${rel} (lines ${slice.length ? start + 1 : 0}-${start + slice.length} of ${total}, revision: ${rev}) ---`;
  return {
    content: [{ type: 'text', text: (body ? body + '\n' : '') + footer }],
    fileVersions: [{ path: rel, revision: rev, size: bytes.length }],
  };
}

async function listDirTree(root, rel, maxDepth = 2, signal) {
  const { fullPath, stat } = resolveNoSymlink(root, rel);
  if (!stat.isDirectory()) fail('NOT_A_DIRECTORY');
  const lines = [];
  const walk = async (dir, prefix, depth) => {
    if (lines.length >= 400) return;
    if (signal?.aborted) fail('READ_CANCELLED');
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (lines.length >= 400) break;
      if (signal?.aborted) fail('READ_CANCELLED');
      if (ent.isSymbolicLink()) continue;
      const entryRel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        lines.push(`${entryRel}/`);
        if (depth < maxDepth && !SKIP_DIRS.has(ent.name)) await walk(join(dir, ent.name), entryRel, depth + 1);
      } else if (ent.isFile()) {
        lines.push(entryRel);
      }
    }
  };
  await walk(fullPath, rel === '.' ? '' : rel, 1);
  return {
    content: [{ type: 'text', text: lines.length ? lines.join('\n') : '(empty directory)' }],
  };
}

async function searchWithRipgrep(root, rel, fullPath, stat, { pattern, searchType, literalSearch, maxResults }, signal) {
  if (!hasRipgrep()) return null;
  try {
    if (signal?.aborted) fail('READ_CANCELLED');
    if (searchType === 'files') {
      const target = stat.isFile() ? fullPath : fullPath;
      const { stdout: out } = await execFileAsync('rg', [
        '--files', '--no-follow', '--hidden', '--no-ignore',
        '--glob', '!.git', '--glob', '!.git/**', '--glob', '!node_modules', '--glob', '!node_modules/**',
        target,
      ], { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) });
      const re = literalSearch ? null : new RegExp(pattern, 'i');
      const needle = pattern.toLowerCase();
      const matches = [];
      const prefix = root.endsWith('/') ? root : root + '/';
      for (const rawLine of out.split(/\r?\n/)) {
        if (!rawLine || matches.length >= maxResults) break;
        const fileRel = rawLine.startsWith(prefix) ? rawLine.slice(prefix.length) : rawLine;
        const hit = re ? re.test(fileRel) : fileRel.toLowerCase().includes(needle);
        if (hit) matches.push(fileRel);
      }
      return { content: [{ type: 'text', text: matches.length ? matches.join('\n') : '(no matches)' }] };
    }
    const args = [
      '--no-follow', '--hidden', '--no-ignore', '--ignore-case',
      '--line-number', '--no-heading', '--with-filename', '--color', 'never',
      '--max-filesize', '1M', '--max-count', String(maxResults),
      '--glob', '!.git', '--glob', '!.git/**', '--glob', '!node_modules', '--glob', '!node_modules/**',
      ...(literalSearch ? ['--fixed-strings'] : []),
      '--', pattern, fullPath,
    ];
    let out = '';
    try {
      ({ stdout: out } = await execFileAsync('rg', args, { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) }));
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') fail('READ_CANCELLED');
      if (err.code === 1 || err.status === 1) out = '';
      else return null;
    }
    const prefix = root.endsWith('/') ? root : root + '/';
    const matches = [];
    for (const rawLine of out.split(/\r?\n/)) {
      if (!rawLine || matches.length >= maxResults) break;
      const clean = rawLine.startsWith(prefix) ? rawLine.slice(prefix.length) : rawLine;
      const idx1 = clean.indexOf(':');
      const idx2 = idx1 > 0 ? clean.indexOf(':', idx1 + 1) : -1;
      if (idx2 > 0) {
        const head = clean.slice(0, idx2);
        const body = clean.slice(idx2 + 1).slice(0, 240);
        matches.push(`${head}: ${body}`);
      } else {
        matches.push(clean.slice(0, 260));
      }
    }
    return { content: [{ type: 'text', text: matches.length ? matches.join('\n') : '(no matches)' }] };
  } catch (err) {
    if (err?.code === 'READ_CANCELLED' || signal?.aborted || err?.name === 'AbortError') fail('READ_CANCELLED');
    return null;
  }
}

async function searchWorkspace(root, { path: rel, pattern, searchType, literalSearch, maxResults }, signal) {
  const { fullPath, stat } = resolveNoSymlink(root, rel);
  if (!stat.isDirectory() && !stat.isFile()) fail('FILE_NOT_FOUND');
  let re;
  try {
    re = literalSearch ? null : new RegExp(pattern, 'i');
  } catch { fail('INVALID_REGEX'); }
  const fast = await searchWithRipgrep(root, rel, fullPath, stat, { pattern, searchType, literalSearch, maxResults }, signal);
  if (fast) return fast;
  const needle = pattern.toLowerCase();
  const matches = [];
  let visited = 0;

  const inspectFile = async (fp, fileRel) => {
    if (matches.length >= maxResults || visited >= MAX_SEARCH_FILES) return;
    if (signal?.aborted) fail('READ_CANCELLED');
    visited++;
    if (searchType === 'files') {
      const hit = re ? re.test(fileRel) : fileRel.toLowerCase().includes(needle);
      if (hit) matches.push(fileRel);
      return;
    }
    let st;
    try { st = await lstat(fp); } catch { return; }
    if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) return;
    let buf;
    try { buf = await readFile(fp); } catch { return; }
    if (buf.subarray(0, 4096).includes(0)) return;
    const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
      const line = lines[i];
      const hit = re ? re.test(line) : line.toLowerCase().includes(needle);
      if (hit) matches.push(`${fileRel}:${i + 1}: ${line.slice(0, 240)}`);
    }
  };

  const walk = async (dir, prefix) => {
    if (matches.length >= maxResults || visited >= MAX_SEARCH_FILES) return;
    if (signal?.aborted) fail('READ_CANCELLED');
    let entries;
    try { entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return; }
    for (const ent of entries) {
      if (matches.length >= maxResults || visited >= MAX_SEARCH_FILES) break;
      if (signal?.aborted) fail('READ_CANCELLED');
      if (ent.isSymbolicLink()) continue;
      const entryRel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) await walk(join(dir, ent.name), entryRel);
      } else if (ent.isFile()) {
        await inspectFile(join(dir, ent.name), entryRel);
      }
    }
  };

  if (stat.isFile()) await inspectFile(fullPath, rel);
  else await walk(fullPath, rel === '.' ? '' : rel);

  return {
    content: [{ type: 'text', text: matches.length ? matches.join('\n') : '(no matches)' }],
  };
}

function runShellCommand(cwd, command, input, signal, emit) {
  return new Promise(resolvePromise => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME || '/tmp',
        LANG: process.env.LANG || 'C.UTF-8',
        TERM: 'dumb',
      },
    });
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const onAbort = () => killGroup();
    if (signal?.aborted) { killGroup(); }
    else signal?.addEventListener('abort', onAbort, { once: true });

    let combined = '';
    const appendOut = (stream, chunk) => {
      if (chunk) {
        emit?.(stream, chunk);
        if (combined.length < 48000) combined += chunk;
      }
    };
    for (const [name, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      const dec = new StringDecoder('utf8');
      pipe.on('data', buf => {
        for (let i = 0; i < buf.length; i += 2048) appendOut(name, dec.write(buf.subarray(i, i + 2048)));
      });
      pipe.on('end', () => appendOut(name, dec.end()));
    }
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(String(input));
    else child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, 120000);
    child.once('error', err => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        version: 1, ok: false, committed: true, error: err.code || 'SPAWN_FAILED',
        response: { isError: true, content: [{ type: 'text', text: `Command spawn failed: ${err.message}` }] },
      });
    });
    child.once('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      killGroup();
      const ok = !timedOut && code === 0 && !sig;
      const summary = timedOut
        ? (combined.trim() ? `${combined.trim()}\n[Command timed out after 120s]` : 'Command timed out after 120s')
        : (combined.trim() || (ok ? '(command succeeded with no output)' : `Command exited with code=${code ?? 'null'} signal=${sig ?? 'none'}`));
      resolvePromise({
        version: 1, ok, committed: true,
        process: { exitCode: code, signal: sig ?? null, ...(timedOut ? { timedOut: true } : {}) },
        response: { isError: !ok, content: [{ type: 'text', text: summary.slice(-32000) }] },
      });
    });
  });
}

export function linuxWorkspace({ browserManager = null } = {}) {
  const bgByWorkspace = new Map();
  const getBg = (key) => {
    let mgr = bgByWorkspace.get(key);
    if (!mgr) {
      mgr = new BackgroundProcessManager({ stateDir: key, platform: 'linux' });
      bgByWorkspace.set(key, mgr);
    }
    return mgr;
  };
  const buildSandbox = () => {
    const browserTools = browserManager?.supportedTools?.() ?? [];
    const browserInfo = browserManager?.publicState?.() ?? null;
    return {
      platform: 'linux',
      shell: '/bin/bash',
      network: true,
      isolation: 'none',
      timeoutMs: 120000,
      supportedTools: [...BASE_TOOLS, ...browserTools],
      ...(browserInfo ? { browser: browserInfo } : {}),
    };
  };

  const launcher = profile => {
    const bgKey = profile.stateDir || profile.workspaceRoot;
    const bg = getBg(bgKey);
    return (op, grant) => {
      const root = realpathSync(profile.workspaceRoot);
      const rootIdentity = profile.rootIdentity ?? identifyLinuxRoot(root);
      const req = op.request;
      const readOnly = Boolean(profile.readOnly) || (grant && !grant.capabilities.includes('workspace.write'));
      const canExec = Boolean(grant && grant.capabilities.includes('workspace.exec'));
      const tool = req.kind === 'dc.tool' ? req.args.tool : null;
      const isBgRead = tool && BG_READ_TOOLS.has(tool);
      const isBgWrite = tool && BG_WRITE_TOOLS.has(tool);
      const isBrowserRead = tool && BROWSER_READ_TOOLS.has(tool);
      const isBrowserWrite = tool && BROWSER_WRITE_TOOLS.has(tool);
      const mutates = req.kind === 'dc.run' || isBgWrite || isBrowserWrite ||
        (tool && ['write_file', 'edit_block', 'create_directory', 'delete_file', 'move_file', 'apply_patch'].includes(tool));

      if (isBrowserRead || isBrowserWrite) {
        if (!browserManager) fail('BROWSER_NOT_AVAILABLE');
        const execBrowser = async (signal) => browserManager.execute(tool, req.args.arguments ?? {}, { signal });
        return mutates
          ? { mutates: true, perform: execBrowser }
          : { mutates: false, read: execBrowser };
      }

      if (isBgRead || isBgWrite) {
        if (!canExec) fail('EXEC_DENIED');
        const execBg = async () => {
          assertRoot(root, rootIdentity);
          const a = req.args.arguments ?? {};
          if (tool === 'bg_start') {
            const { fullPath: cwdPath, stat } = resolveNoSymlink(root, a.cwd ?? '.');
            if (!stat.isDirectory()) fail('NOT_A_DIRECTORY');
            const info = await bg.start({ cwd: cwdPath, command: a.command, waitMs: a.waitMs ?? 1500 });
            return { version: 1, ok: true, committed: true, calls: 1, response: { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] } };
          }
          if (tool === 'bg_list') {
            return { version: 1, ok: true, calls: 1, response: { content: [{ type: 'text', text: JSON.stringify({ processes: bg.list() }, null, 2) }] } };
          }
          if (tool === 'bg_output') {
            const info = await bg.output({ processId: a.processId, afterSeq: a.afterSeq ?? 0, waitMs: a.waitMs ?? 0 });
            return { version: 1, ok: true, calls: 1, response: { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] } };
          }
          if (tool === 'bg_input') {
            const info = bg.input({ processId: a.processId, input: a.input });
            return { version: 1, ok: true, committed: true, calls: 1, response: { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] } };
          }
          if (tool === 'bg_stop') {
            const info = await bg.stop({ processId: a.processId });
            return { version: 1, ok: true, committed: true, calls: 1, response: { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] } };
          }
          fail('TOOL_DENIED');
        };
        return mutates ? { mutates: true, perform: execBg } : { mutates: false, read: execBg };
      }

      return {
        mutates,
        read: !mutates ? async (signal) => {
          assertRoot(root, rootIdentity);
          if (req.kind === 'dc.search') {
            return { version: 1, ok: true, calls: 1, response: await searchWorkspace(root, req.args, signal) };
          }
          const a = req.args.arguments;
          if (tool === 'read_file') {
            const r = readOneFile(root, a.path, a.offset ?? 0, a.length ?? 200);
            return { version: 1, ok: true, calls: 1, fileVersions: r.fileVersions, response: { content: r.content } };
          }
          if (tool === 'read_multiple_files') {
            const content = [], fileVersions = [];
            for (const p of a.paths) {
              try {
                const r = readOneFile(root, p, 0, 200);
                content.push(...r.content);
                fileVersions.push(...r.fileVersions);
              } catch (err) {
                content.push({ type: 'text', text: `Error reading ${p}: ${err.code || err.message}` });
              }
            }
            return { version: 1, ok: true, calls: 1, fileVersions, response: { content } };
          }
          if (tool === 'list_directory') {
            return { version: 1, ok: true, calls: 1, response: await listDirTree(root, a.path, a.depth ?? 2, signal) };
          }
          if (tool === 'get_file_info') {
            const { fullPath, stat } = resolveNoSymlink(root, a.path);
            const info = {
              path: a.path, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
              size: stat.size, modifiedAt: stat.mtime.toISOString(),
            };
            let fileVersions;
            if (stat.isFile() && stat.size <= MAX_READ_BYTES) {
              const bytes = readFileSync(fullPath);
              info.revision = revisionOf(bytes);
              if (!bytes.subarray(0, 8192).includes(0)) info.lines = bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n').length;
              fileVersions = [{ path: a.path, revision: info.revision, size: bytes.length }];
            }
            return { version: 1, ok: true, calls: 1, ...(fileVersions ? { fileVersions } : {}), response: { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] } };
          }
          fail('TOOL_DENIED');
        } : undefined,

        perform: mutates ? async (signal, emit) => {
          assertRoot(root, rootIdentity);
          if (req.kind === 'dc.run') {
            if (!canExec) fail('EXEC_DENIED');
            const { fullPath: cwdPath, stat } = resolveNoSymlink(root, req.cwdRelative);
            if (!stat.isDirectory()) fail('NOT_A_DIRECTORY');
            return runShellCommand(cwdPath, req.args.command, req.args.input, signal, emit);
          }
          if (readOnly) fail('WRITE_DENIED');
          const a = req.args.arguments;
          if (tool === 'create_directory') {
            const { fullPath, stat } = resolveNoSymlink(root, a.path, { allowMissingParents: true });
            if (stat && !stat.isDirectory()) fail('FILE_EXISTS');
            mkdirSync(fullPath, { recursive: true });
            return { version: 1, ok: true, committed: true, calls: 1, response: { content: [{ type: 'text', text: `Created directory ${a.path}` }] } };
          }
          if (tool === 'write_file') {
            const { fullPath, stat } = resolveNoSymlink(root, a.path, { allowMissingLeaf: true, allowMissingParents: true });
            checkRevision(fullPath, stat, a.expectedRevision);
            const next = a.mode === 'append' && stat ? Buffer.concat([readFileSync(fullPath), Buffer.from(a.content, 'utf8')]) : Buffer.from(a.content, 'utf8');
            atomicWrite(fullPath, next);
            const rev = revisionOf(next);
            return {
              version: 1, ok: true, committed: true, calls: 1,
              fileVersions: [{ path: a.path, revision: rev, size: next.length }],
              response: { content: [{ type: 'text', text: `Wrote ${a.path} (${next.length} bytes, revision: ${rev})` }] },
            };
          }
          if (tool === 'edit_block') {
            const { fullPath, stat } = resolveNoSymlink(root, a.file_path);
            if (!stat.isFile()) fail('NOT_A_FILE');
            checkRevision(fullPath, stat, a.expectedRevision);
            const orig = readFileSync(fullPath, 'utf8');
            const expected = a.expected_replacements ?? 1;
            const parts = orig.split(a.old_string);
            const found = parts.length - 1;
            if (found !== expected) {
              return {
                version: 1, ok: false, committed: false, error: 'EDIT_MISMATCH',
                response: { isError: true, content: [{ type: 'text', text: `Expected ${expected} occurrence(s) of old_string in ${a.file_path}, found ${found}.` }] },
              };
            }
            const nextBuf = Buffer.from(parts.join(a.new_string), 'utf8');
            atomicWrite(fullPath, nextBuf);
            const rev = revisionOf(nextBuf);
            return {
              version: 1, ok: true, committed: true, calls: 1,
              fileVersions: [{ path: a.file_path, revision: rev, size: nextBuf.length }],
              response: { content: [{ type: 'text', text: `Edited ${a.file_path} (${found} replacement(s), revision: ${rev})` }] },
            };
          }
          if (tool === 'delete_file') {
            const { fullPath, stat } = resolveNoSymlink(root, a.path);
            if (!stat.isFile()) fail('NOT_A_FILE');
            checkRevision(fullPath, stat, a.expectedRevision);
            unlinkSync(fullPath);
            return { version: 1, ok: true, committed: true, calls: 1, response: { content: [{ type: 'text', text: `Deleted ${a.path}` }] } };
          }
          if (tool === 'move_file') {
            const from = resolveNoSymlink(root, a.fromPath);
            if (!from.stat.isFile()) fail('NOT_A_FILE');
            checkRevision(from.fullPath, from.stat, a.expectedFromRevision);
            const to = resolveNoSymlink(root, a.toPath, { allowMissingLeaf: true, allowMissingParents: true });
            checkRevision(to.fullPath, to.stat, a.expectedToRevision);
            mkdirSync(dirname(to.fullPath), { recursive: true });
            renameSync(from.fullPath, to.fullPath);
            const bytes = readFileSync(to.fullPath);
            const rev = revisionOf(bytes);
            return {
              version: 1, ok: true, committed: true, calls: 1,
              fileVersions: [{ path: a.toPath, revision: rev, size: bytes.length }],
              response: { content: [{ type: 'text', text: `Moved ${a.fromPath} -> ${a.toPath} (revision: ${rev})` }] },
            };
          }
          if (tool === 'apply_patch') {
            const ops = parsePatch(a.patch);
            const planned = [];
            for (const pOp of ops) {
              if (!Object.hasOwn(a.expectedRevisions, pOp.path)) fail('MISSING_FILE_REVISION');
              if (pOp.kind === 'add') {
                const target = resolveNoSymlink(root, pOp.path, { allowMissingLeaf: true, allowMissingParents: true });
                checkRevision(target.fullPath, target.stat, a.expectedRevisions[pOp.path]);
                const text = pOp.lines.join('\n') + (pOp.lines.length ? '\n' : '');
                planned.push({ kind: 'write', path: pOp.path, fullPath: target.fullPath, bytes: Buffer.from(text, 'utf8') });
              } else if (pOp.kind === 'delete') {
                const target = resolveNoSymlink(root, pOp.path);
                if (!target.stat.isFile()) fail('NOT_A_FILE');
                checkRevision(target.fullPath, target.stat, a.expectedRevisions[pOp.path]);
                planned.push({ kind: 'delete', path: pOp.path, fullPath: target.fullPath });
              } else if (pOp.kind === 'update') {
                const src = resolveNoSymlink(root, pOp.path);
                if (!src.stat.isFile()) fail('NOT_A_FILE');
                checkRevision(src.fullPath, src.stat, a.expectedRevisions[pOp.path]);
                const updatedText = applyHunks(readFileSync(src.fullPath, 'utf8'), pOp.hunks, pOp.path);
                const bytes = Buffer.from(updatedText, 'utf8');
                if (pOp.moveTo) {
                  const dst = resolveNoSymlink(root, pOp.moveTo, { allowMissingLeaf: true, allowMissingParents: true });
                  if (Object.hasOwn(a.expectedRevisions, pOp.moveTo)) checkRevision(dst.fullPath, dst.stat, a.expectedRevisions[pOp.moveTo]);
                  else if (dst.stat) fail('FILE_EXISTS');
                  planned.push({ kind: 'moveWrite', fromPath: pOp.path, fromFull: src.fullPath, path: pOp.moveTo, fullPath: dst.fullPath, bytes });
                } else {
                  planned.push({ kind: 'write', path: pOp.path, fullPath: src.fullPath, bytes });
                }
              }
            }
            const fileVersions = [], summaryLines = [];
            for (const step of planned) {
              if (step.kind === 'write') {
                atomicWrite(step.fullPath, step.bytes);
                const rev = revisionOf(step.bytes);
                fileVersions.push({ path: step.path, revision: rev, size: step.bytes.length });
                summaryLines.push(`Updated ${step.path} (revision: ${rev})`);
              } else if (step.kind === 'delete') {
                unlinkSync(step.fullPath);
                summaryLines.push(`Deleted ${step.path}`);
              } else if (step.kind === 'moveWrite') {
                atomicWrite(step.fullPath, step.bytes);
                unlinkSync(step.fromFull);
                const rev = revisionOf(step.bytes);
                fileVersions.push({ path: step.path, revision: rev, size: step.bytes.length });
                summaryLines.push(`Moved & updated ${step.fromPath} -> ${step.path} (revision: ${rev})`);
              }
            }
            return {
              version: 1, ok: true, committed: true, calls: 1, fileVersions,
              response: { content: [{ type: 'text', text: summaryLines.join('\n') }] },
            };
          }
          fail('TOOL_DENIED');
        } : undefined,
      };
    };
  };

  return {
    identifyRoot: identifyLinuxRoot,
    canMigrateRoot: canMigrateLegacyRootIdentity,
    modes: ['revoked', 'read', 'edit', 'execute'],
    sandbox: buildSandbox(),
    getSandbox: buildSandbox,
    onGrantChange(grant, stateDir) {
      if (!grant?.capabilities?.includes('workspace.exec')) {
        if (stateDir) void bgByWorkspace.get(stateDir)?.stopAll();
        else for (const mgr of bgByWorkspace.values()) void mgr.stopAll();
      }
    },
    async onClose(stateDir) {
      if (stateDir) await bgByWorkspace.get(stateDir)?.stopAll();
      else await Promise.allSettled([...bgByWorkspace.values()].map(m => m.stopAll()));
    },
    launcher,
  };
}
