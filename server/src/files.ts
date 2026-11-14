import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);

/**
 * Resolves a path and verifies it lies inside one of `roots` (by default the whole workspace;
 * a member's own folder for members, see accounts.ts).
 */
export async function safeDir(path: string, roots: string[] = config.workspaceRoots): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new Error('目录不存在');
  }
  const reals = await Promise.all(roots.map((r) => realpath(r).catch(() => null)));
  const allowed = reals.some((root) => root && (real === root || real.startsWith(root + sep)));
  if (!allowed) throw new Error(roots === config.workspaceRoots ? '目录不在允许的工作区内' : '目录不在你的文件夹内');
  if (!(await stat(real)).isDirectory()) throw new Error('不是目录');
  return real;
}

/** Roots with symlinks resolved; only successes are cached, so a member folder created later is found. */
const rootCache = new Map<string, string>();
function realRoot(root: string): string | null {
  let real = rootCache.get(root);
  if (real === undefined) {
    try {
      real = realpathSync(root);
    } catch {
      return null;
    }
    rootCache.set(root, real);
  }
  return real;
}

/** Synchronous variant of the workspace check, for annotating session lists. */
export function inWorkspace(path: string, roots: string[] = config.workspaceRoots): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  return roots.some((r) => {
    const root = realRoot(r);
    return !!root && (real === root || real.startsWith(root + sep));
  });
}

/** `realpath`, falling back to the path itself when it no longer exists. Cached: paths are stable for a session list. */
const realCache = new Map<string, string>();
function realOrSelf(path: string): string {
  let real = realCache.get(path);
  if (real === undefined) {
    try {
      real = realpathSync(path);
    } catch {
      real = path;
    }
    realCache.set(path, real);
  }
  return real;
}

/** Roots with symlinks resolved, index-aligned with `roots`. */
export function realWorkspaceRoots(roots: string[] = config.workspaceRoots): string[] {
  return roots.map(realOrSelf);
}

const projectCache = new Map<string, string>();

/**
 * The git repository containing `cwd`, or `cwd` itself; used to group sessions by project.
 * Symlinks are resolved first, so the same folder reached through different paths
 * (e.g. after moving it and leaving a symlink behind) lands in one group.
 */
export function projectOf(cwd: string): string {
  const hit = projectCache.get(cwd);
  if (hit) return hit;
  const real = realOrSelf(cwd);
  let dir = real;
  let project = real;
  while (true) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      project = dir;
      // A linked worktree (.git is a file pointing into <repo>/.git/worktrees/<name>) belongs to its repository.
      if (statSync(dotGit).isFile()) {
        const target = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
        const main = target?.match(/^(.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/)?.[1];
        if (main) project = main;
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  projectCache.set(cwd, project);
  return project;
}

/** Where `cwd` sits inside `project` ('' at the root or when it is not inside, e.g. a linked worktree). */
export function subdirOf(cwd: string, project: string): string {
  const rel = relative(project, realOrSelf(cwd));
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : '';
}

export async function listDirs(path: string, roots?: string[]) {
  const dir = await safeDir(path, roots);
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const isGit = entries.some((e) => e.name === '.git');
  return { path: dir, isGit, dirs: dirs.map((name) => ({ name, path: join(dir, name) })) };
}

/** Creates a folder `name` in `parent` (both inside `roots`); returns its path. */
export async function makeDir(parent: string, name: string, roots?: string[]): Promise<string> {
  const dir = await safeDir(parent, roots);
  const clean = name.trim();
  if (!clean || clean.startsWith('.') || /[\/\\\u0000-\u001f]/.test(clean)) throw new Error('文件夹名不能为空，不能以 . 开头，也不能包含 / 或 \\');
  if (clean.length > 100) throw new Error('文件夹名太长');
  const path = join(dir, clean);
  try {
    await mkdir(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`「${clean}」已经存在`);
    throw e;
  }
  return path;
}

const MAX_DIFF = 2_000_000;

export async function gitDiff(cwd: string) {
  // quotepath=false: non-ASCII paths stay readable and match `git status -z`.
  const git = (...args: string[]) =>
    run('git', ['-c', 'core.quotepath=false', ...args], { cwd, maxBuffer: 20 * 1024 * 1024 }).then((r) => r.stdout);
  try {
    await git('rev-parse', '--is-inside-work-tree');
  } catch {
    return { isGit: false, branch: '', status: '', diff: '' };
  }
  const [branch, status] = await Promise.all([
    git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => '(no commits)'),
    git('status', '--porcelain=v1', '-uall'),
  ]);
  // Untracked files are diffed against /dev/null so new files show up too.
  let diff = await git('diff', 'HEAD', '--no-color').catch(() => git('diff', '--no-color'));
  // -z: paths come unquoted, even with spaces or non-ASCII characters.
  const untracked = (await git('status', '--porcelain=v1', '-z', '-uall'))
    .split('\0')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3));
  for (const f of untracked.slice(0, 200)) {
    if (diff.length > MAX_DIFF) break;
    diff += await run('git', ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-index', '--', '/dev/null', f], { cwd, maxBuffer: 20 * 1024 * 1024 })
      .then((r) => r.stdout)
      .catch((e: { stdout?: string }) => e.stdout ?? ''); // exits 1 when files differ
  }
  if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + '\n… [diff 过大，已截断]';
  return { isGit: true, branch: branch.trim(), status, diff };
}

export async function cliVersions() {
  const v = (bin: string | undefined, name: string) =>
    run(bin ?? name, ['--version'])
      .then((r) => r.stdout.trim())
      .catch(() => null);
  const [claude, codex] = await Promise.all([v(config.claudePath, 'claude'), v(config.codexPath, 'codex')]);
  return { claude, codex };
}
