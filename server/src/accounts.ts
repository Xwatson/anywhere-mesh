// Where each account works, and its AI memory.
// Admins work on this machine, in the whole workspace, with its own Claude / Codex setup.
// Every other account (a member) works only on its own computer, over SSH (remote_host): its
// agents get no tools for this machine at all (see agents/account.ts). Here a member only has a
// folder, <first workspace root>/<username>, holding its memory: AGENTS.md, shared by Claude and
// Codex (CLAUDE.md imports it) — the layout of a folder set up by hand to work on someone's computer.
// Deliberately light (config + db only): the CLI imports it while the service may be running.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import type { RemoteTarget } from './remote/ssh.js';

export interface Account {
  id: number;
  username: string;
  isAdmin: boolean;
  /** A member's own computer; null until an admin sets it (the member cannot work before). */
  remote: RemoteTarget | null;
}

/** The account memory in a member's folder, loaded by every session; CLAUDE.md imports it. */
export const MEMORY_FILE = 'AGENTS.md';

/** Where the folder of the account named `username` is (or would be), whatever its role. */
export const homePathOf = (username: string) => join(config.workspaceRoots[0], username);

/** A member's own folder; null for admins, who work in the whole workspace. */
export const homeOf = (a: Pick<Account, 'username' | 'isAdmin'>): string | null => (a.isAdmin ? null : homePathOf(a.username));

/** Folders the account's sessions may be started in: the whole workspace, or a member's own folder. */
export function rootsOf(a: Pick<Account, 'username' | 'isAdmin'>): string[] {
  const home = homeOf(a);
  return home ? [home] : config.workspaceRoots;
}

/** A member's memory file; null for admins (their Claude uses this machine's ~/.claude/CLAUDE.md). */
export function memoryFileOf(a: Pick<Account, 'username' | 'isAdmin'>): string | null {
  const home = homeOf(a);
  return home ? join(home, MEMORY_FILE) : null;
}

// Accounts are looked up for every session row; roles change rarely. Briefly cached: a change made
// from the CLI (another process) is picked up within seconds.
const cache = new Map<number, { a: Account | null; at: number }>();
const CACHE_MS = 10_000;

export function account(id: number): Account | null {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.a;
  const row = db.prepare('SELECT id, username, is_admin, remote_host, remote_port FROM users WHERE id = ?').get(id) as
    | { id: number; username: string; is_admin: number; remote_host: string | null; remote_port: number | null }
    | undefined;
  const a = row
    ? { id: row.id, username: row.username, isAdmin: !!row.is_admin, remote: row.remote_host ? { host: row.remote_host, port: row.remote_port } : null }
    : null;
  cache.set(id, { a, at: Date.now() });
  return a;
}

/** Call after an account's role or computer changed, or it was deleted. */
export const forgetAccount = (id: number) => cache.delete(id);

/** The folders the account with this id may start sessions in (none for an unknown account). */
export function rootsOfId(id: number): string[] {
  const a = account(id);
  return a ? rootsOf(a) : [];
}

export function setRemote(id: number, remote: RemoteTarget | null) {
  db.prepare('UPDATE users SET remote_host = ?, remote_port = ? WHERE id = ?').run(remote?.host ?? null, remote?.port ?? null, id);
  forgetAccount(id);
}

/** Whether `username`'s folder already exists (someone's files, or left behind by a deleted account of that name). */
export const folderExists = (username: string) => existsSync(homePathOf(username));

const memoryTemplate = (username: string, remote: RemoteTarget | null) => `# ${username} 的记忆（Claude / Codex 共用）

> 这个文件夹只是账号「${username}」在服务器上的入口和记忆目录。项目都在 ${username} 自己的电脑上${remote ? `（${remote.host}${remote.port ? ` 端口 ${remote.port}` : ''}）` : ''}，AI 通过 SSH 操作那台电脑。
> AI 每个会话开始时都会读到这份记忆，学到值得长期记住的东西时会自己更新；你也可以直接修改。不要写密码、密钥。

## 电脑
（系统、shell、常用工具和路径）

## 偏好

## 项目
`;

const CLAUDE_MD = `# CLAUDE.md

本目录的记忆与 Codex 共用，唯一来源是 AGENTS.md：

@AGENTS.md
`;

/** Creates a member's folder with its memory when missing (an existing AGENTS.md is kept). Returns the folder, or null for admins. */
export function ensureHome(a: Pick<Account, 'username' | 'isAdmin'> & { remote?: RemoteTarget | null }): string | null {
  const home = homeOf(a);
  if (!home) return null;
  mkdirSync(home, { recursive: true });
  const memory = join(home, MEMORY_FILE);
  if (!existsSync(memory)) writeFileSync(memory, memoryTemplate(a.username, a.remote ?? null));
  const claude = join(home, 'CLAUDE.md');
  if (!existsSync(claude)) writeFileSync(claude, CLAUDE_MD);
  return home;
}

/** A file's modification time, 0 when missing. */
export function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
