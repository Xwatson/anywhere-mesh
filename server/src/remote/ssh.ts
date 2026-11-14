// Commands and files on an account's own computer, over SSH. Uses the system ssh / sftp, so
// ~/.ssh/config (Host aliases), keys and known_hosts apply exactly as in a terminal.
// Standalone (node built-ins only): the remote MCP server imports it as its own process.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RemoteTarget {
  /** user@host, or a Host alias from ~/.ssh/config. */
  host: string;
  port?: number | null;
}

/** user@host or an alias: never an option, never a space. */
export const validHost = (h: string) => /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])$/.test(h);
export const validPort = (p: unknown) => p === null || p === undefined || (Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536);

/**
 * Every connection: never prompt (no terminal to answer), and nothing is forwarded back to this
 * machine (agent, ports, X11, local commands), so the far side cannot reach in through it.
 */
const BASE_OPTS = [
  ['BatchMode', 'yes'],
  ['ConnectTimeout', '15'],
  ['ServerAliveInterval', '15'],
  ['ServerAliveCountMax', '3'],
  ['StrictHostKeyChecking', 'accept-new'],
  ['ForwardAgent', 'no'],
  ['ForwardX11', 'no'],
  ['ClearAllForwardings', 'yes'],
  ['PermitLocalCommand', 'no'],
  ['LogLevel', 'ERROR'],
].flatMap(([k, v]) => ['-o', `${k}=${v}`]);

let controlDir: string | null = null;

/**
 * Reuse one SSH connection for all calls of a session (each call otherwise pays a full handshake):
 * the first call opens a master connection, kept 10 minutes after the last use. The sockets live in
 * `dir`, which must be private to this user.
 */
export function shareConnections(dir: string) {
  controlDir = dir;
}

/** Connection sharing, plus extra `-o` options from the environment for tests (e.g. a scratch known_hosts file). */
const extraOpts = () => [
  ...(controlDir ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlDir}/%C`, '-o', 'ControlPersist=600'] : []),
  ...(process.env.ANYWHERE_SSH_OPTS ?? '').split(/\s+/).filter(Boolean),
];

function checkTarget(t: RemoteTarget) {
  if (!validHost(t.host) || !validPort(t.port)) throw new Error(`无效的 SSH 地址：${t.host}`);
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Output kept per stream; beyond that the start and the end are kept. */
const MAX_CAPTURE = 4 * 1024 * 1024;

function exec(cmd: string, args: string[], input: string | undefined, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    child.stdout!.on('data', (d: Buffer) => (outLen += d.length) <= MAX_CAPTURE && out.push(d));
    child.stderr!.on('data', (d: Buffer) => (errLen += d.length) <= MAX_CAPTURE && err.push(d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: e.message, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
    });
    if (input !== undefined) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(input);
    }
  });
}

/** Runs `command` with the remote user's shell, starting in their home folder. */
export function runRemote(t: RemoteTarget, command: string, opts: { stdin?: string; timeoutMs: number }): Promise<RunResult> {
  checkTarget(t);
  const args = ['-T', ...BASE_OPTS, ...extraOpts(), ...(t.port ? ['-p', String(t.port)] : []), '--', t.host, command];
  return exec('ssh', args, opts.stdin, opts.timeoutMs);
}

/** A path for an sftp batch line: quoted, with glob characters taken literally. sftp has no `~`: paths are relative to home. */
function sftpPath(p: string): string {
  const rel = p === '~' ? '.' : p.replace(/^~[/\\]/, '');
  return `"${rel.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/([*?[])/g, '\\$1')}"`;
}

async function sftp(t: RemoteTarget, batch: string, timeoutMs = 120_000): Promise<void> {
  checkTarget(t);
  const args = [...BASE_OPTS, ...extraOpts(), ...(t.port ? ['-P', String(t.port)] : []), '-b', '-', '--', t.host];
  const r = await exec('sftp', args, batch + '\n', timeoutMs);
  if (r.timedOut) throw new Error('传输超时');
  if (r.code !== 0) {
    const msg = r.stderr.split('\n').filter((l) => l.trim() && !/^sftp>/.test(l)).join('\n').trim();
    throw new Error(msg || `sftp 失败（退出码 ${r.code}）`);
  }
}

const MAX_FILE = 20 * 1024 * 1024;

/** Downloads a remote file (sftp: binary-safe, the same on macOS, Linux and Windows). */
export async function readRemoteFile(t: RemoteTarget, path: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'anywhere-remote-'));
  try {
    const local = join(dir, 'file');
    await sftp(t, `get ${sftpPath(path)} ${sftpPath(local)}`);
    if ((await stat(local)).size > MAX_FILE) throw new Error(`文件超过 ${MAX_FILE / 1024 / 1024}MB，请用 run 分段查看`);
    return await readFile(local);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `-mkdir` (errors ignored) for every folder above a remote path, so a write never fails for a missing folder. */
function mkdirsFor(path: string): string[] {
  const parts = path.replace(/\\/g, '/').split('/');
  parts.pop();
  const lines: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (dir && dir !== '~' && !/^[A-Za-z]:$/.test(dir)) lines.push(`-mkdir ${sftpPath(dir)}`);
  }
  return lines;
}

/** Uploads `data` (or a local file) to a remote path, creating its folders first. */
export async function writeRemoteFile(t: RemoteTarget, path: string, data: Buffer | string | { localFile: string }): Promise<void> {
  if (typeof data === 'object' && 'localFile' in data) {
    return sftp(t, [...mkdirsFor(path), `put ${sftpPath(data.localFile)} ${sftpPath(path)}`].join('\n'), 600_000);
  }
  const dir = await mkdtemp(join(tmpdir(), 'anywhere-remote-'));
  try {
    const local = join(dir, 'file');
    await writeFile(local, data, { mode: 0o600 });
    await sftp(t, [...mkdirsFor(path), `put ${sftpPath(local)} ${sftpPath(path)}`].join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Removes a remote file (sftp, so the same on every system). */
export function removeRemoteFile(t: RemoteTarget, path: string): Promise<void> {
  return sftp(t, `rm ${sftpPath(path)}`);
}

/** Whether the computer answers, and what it is, for the admin's "测试连接". */
export async function testRemote(t: RemoteTarget): Promise<{ ok: boolean; output: string }> {
  const fail = (e: Error): RunResult => ({ code: null, stdout: '', stderr: e.message, timedOut: false });
  // `echo` works in every remote shell (bash, zsh, cmd, PowerShell); `&&` and `;` do not.
  const r = await runRemote(t, 'echo __anywhere_ok__', { timeoutMs: 25_000 }).catch(fail);
  if (!r.stdout.includes('__anywhere_ok__')) {
    return { ok: false, output: r.timedOut ? '连接超时' : (r.stderr.trim() || `连接失败（退出码 ${r.code}）`).slice(0, 500) };
  }
  const u = await runRemote(t, 'uname -srm', { timeoutMs: 15_000 }).catch(fail);
  const system = u.code === 0 ? u.stdout.trim() : '';
  return { ok: true, output: `连接成功${system ? `：${system}` : '（没有 uname，可能是 Windows）'}` };
}

/** A folder on the remote computer and the folders in it, for choosing a project there. */
export interface RemoteListing {
  /** Absolute path (as the remote system writes it). */
  path: string;
  /** Its parent folder, null at the top. */
  parent: string | null;
  isGit: boolean;
  dirs: string[];
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A path for a POSIX shell: `~` and `~/…` stay relative to the home folder, everything else quoted. */
const shPath = (p: string) => (!p || p === '~' ? '"$HOME"' : p.startsWith('~/') ? `"$HOME"/${shq(p.slice(2))}` : shq(p));

/**
 * The folders in `path` on the remote computer (default: the home folder). macOS and Linux through the
 * shell (exact names, git detected); other systems (Windows) through sftp.
 */
export async function listRemoteDirs(t: RemoteTarget, path: string): Promise<RemoteListing> {
  // Run by /bin/sh whatever the login shell is (zsh stops at a glob that matches nothing).
  const script = `cd -- ${shPath(path)} 2>/dev/null || { printf '__ac_nodir__'; exit 0; }; printf '__ac_pwd__%s\\n' "$PWD"; if [ -e .git ]; then printf '__ac_git__\\n'; fi; for f in *; do [ -d "$f" ] && printf 'D:%s\\n' "$f"; done; exit 0`;
  const r = await runRemote(t, `/bin/sh -c ${shq(script)}`, { timeoutMs: 30_000 });
  if (r.code === 255 && !r.stdout) throw new Error(`连不上这台电脑：${r.stderr.trim().slice(0, 200) || '请确认电脑开着并且在线'}`);
  if (r.stdout.includes('__ac_nodir__')) throw new Error(`没有这个文件夹：${path}`);
  const pwd = r.stdout.match(/__ac_pwd__(.*)\n/)?.[1];
  if (pwd) {
    const dirs = r.stdout.split('\n').filter((l) => l.startsWith('D:')).map((l) => l.slice(2)).filter((n) => !n.startsWith('.'));
    const parent = pwd === '/' ? null : pwd.replace(/\/[^/]+\/?$/, '') || '/';
    return { path: pwd, parent, isGit: r.stdout.includes('__ac_git__'), dirs: dirs.sort((a, b) => a.localeCompare(b)).slice(0, 2000) };
  }
  return listWithSftp(t, path);
}

/** sftp's long listing: shell-independent, for computers without a POSIX shell. */
async function listWithSftp(t: RemoteTarget, path: string): Promise<RemoteListing> {
  checkTarget(t);
  const args = [...BASE_OPTS, ...extraOpts(), ...(t.port ? ['-P', String(t.port)] : []), '-b', '-', '--', t.host];
  const cd = path && path !== '~' ? `cd ${sftpPath(path)}\n` : '';
  const r = await exec('sftp', args, `${cd}pwd\nls -la\n`, 30_000);
  if (r.code !== 0) throw new Error(path ? `打不开这个文件夹：${path}` : '连不上这台电脑');
  const pwd = r.stdout.match(/Remote working directory: (.+)/)?.[1]?.trim() ?? path;
  const dirs = r.stdout
    .split('\n')
    .map((l) => l.match(/^d[rwxsStT-]{9}\S*\s+\d+\s+\S+\s+\S+\s+\d+\s+\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})\s(.+)$/)?.[1])
    .filter((n): n is string => !!n && !n.startsWith('.'));
  const parent = /^\/?[A-Za-z]:\/?$/.test(pwd) || pwd === '/' ? null : pwd.replace(/\/[^/]+\/?$/, '') || '/';
  return { path: pwd, parent, isGit: false, dirs: dirs.sort((a, b) => a.localeCompare(b)) };
}

/** Creates a folder on the remote computer (sftp: the same on every system). */
export async function makeRemoteDir(t: RemoteTarget, parent: string, name: string): Promise<string> {
  const clean = name.trim();
  if (!clean || clean.startsWith('.') || /[\/\\\u0000-\u001f]/.test(clean)) throw new Error('文件夹名不能为空，不能以 . 开头，也不能包含 / 或 \\');
  if (clean.length > 100) throw new Error('文件夹名太长');
  const path = `${parent.replace(/\/+$/, '')}/${clean}`;
  await sftp(t, `mkdir ${sftpPath(path)}`).catch((e: Error) => {
    throw new Error(/exist|Failure/i.test(e.message) ? `「${clean}」可能已经存在：${e.message}` : e.message);
  });
  return path;
}
