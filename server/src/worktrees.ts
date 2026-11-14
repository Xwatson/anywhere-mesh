// One git worktree per task: each session gets its own directory and branch, so several
// agents can change the same project at the same time without stepping on each other.
import { existsSync } from 'node:fs';
import { appendFile, chmod, cp, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { inWorkspace } from './files.js';
import { git, GitError, locked, tryGit } from './git.js';
import type { WorktreeStatus } from './shared/protocol.js';

/** What a session remembers about its worktree. */
export interface WorktreeMeta {
  /** Main working tree of the repository. */
  repo: string;
  /** The worktree's own directory. */
  path: string;
  branch: string;
  /** Branch it was created from, and is merged back into. */
  base: string;
}

/** Main working tree for any directory inside a repository (also from inside another worktree). */
export async function mainRepo(dir: string): Promise<string> {
  const common = await tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) throw new GitError('这个目录不是 git 仓库，不能使用 worktree');
  if (basename(common) !== '.git') throw new GitError('不支持裸仓库或自定义 .git 目录的仓库');
  return dirname(common);
}

const slug = (branch: string) => branch.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';

async function branchExists(repo: string, name: string) {
  return !!(await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]));
}

async function autoBranch(repo: string, agent: string): Promise<string> {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stem = `ac/${agent}-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  for (let i = 0; ; i++) {
    const name = i ? `${stem}-${i + 1}` : stem;
    if (!(await branchExists(repo, name))) return name;
  }
}

/**
 * Next to the repository (`<repo>.worktrees/<branch>`) so the project's own tooling never
 * scans it; inside it (`.worktrees/`, git-excluded) when the parent is outside the workspace
 * (or, for a member, outside their own folder).
 */
async function location(repo: string, branch: string, roots?: string[]): Promise<string> {
  const parent = dirname(repo);
  let base = join(parent, `${basename(repo)}.worktrees`);
  if (!inWorkspace(parent, roots)) {
    base = join(repo, '.worktrees');
    const exclude = join(repo, '.git', 'info', 'exclude');
    const cur = await readFile(exclude, 'utf8').catch(() => '');
    if (!/^\/?\.worktrees\/?$/m.test(cur)) {
      await mkdir(dirname(exclude), { recursive: true });
      await appendFile(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.worktrees/\n`);
    }
  }
  let dir = join(base, slug(branch));
  for (let i = 2; existsSync(dir); i++) dir = join(base, `${slug(branch)}-${i}`);
  return dir;
}

/**
 * Some filesystems give every new file the same mode whatever the umask (this NAS: 755 from
 * its ACL), so a fresh checkout differs from the index by mode alone and every file shows as
 * modified. Put the recorded modes back; elsewhere there is nothing to do.
 */
async function restoreModes(dir: string) {
  const out = (await tryGit(dir, ['-c', 'core.quotepath=false', 'diff', '--summary'])) ?? '';
  for (const line of out.split('\n')) {
    const m = line.match(/^ ?mode change 100(644|755) => 100(?:644|755) (.+)$/);
    if (m) await chmod(join(dir, m[2]), m[1] === '755' ? 0o755 : 0o644).catch(() => {});
  }
}

/**
 * Local files git does not carry over: root-level `.env*` and `CLAUDE.local.md`, plus whatever `.worktreeinclude`
 * lists (one relative path per line, `#` comments).
 */
async function copyLocalFiles(repo: string, dir: string): Promise<string[]> {
  const wanted = new Set<string>();
  for (const e of await readdir(repo, { withFileTypes: true })) {
    if (e.isFile() && (/^\.env(\..+)?$/.test(e.name) || e.name === 'CLAUDE.local.md')) wanted.add(e.name);
  }
  const list = await readFile(join(repo, '.worktreeinclude'), 'utf8').catch(() => '');
  for (const raw of list.split('\n')) {
    const line = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const rel = normalize(line);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel === '.git' || rel.startsWith(`.git${sep}`)) continue;
    wanted.add(rel);
  }
  const copied: string[] = [];
  for (const rel of wanted) {
    const from = join(repo, rel);
    const to = join(dir, rel);
    // Tracked files are already in the worktree; never overwrite what git checked out.
    if (!existsSync(from) || existsSync(to)) continue;
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, errorOnExist: false, force: false });
    copied.push(rel);
  }
  return copied;
}

/** Creates a branch and its worktree for a new session started in `cwd` (a folder in the repository). */
export async function createWorktree(
  cwd: string,
  opts: { branch?: unknown; base?: unknown; agent: string; /** Where the account may work (default: the workspace). */ roots?: string[] },
): Promise<{ meta: WorktreeMeta; cwd: string; copied: string[] }> {
  const repo = await mainRepo(cwd);
  if (!inWorkspace(repo, opts.roots)) throw new GitError('这个仓库的根目录不在你能使用的文件夹内，不能在这里建 worktree');
  return locked(repo, async () => {
    const current = await tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
    const base = typeof opts.base === 'string' && opts.base.trim() ? opts.base.trim() : current;
    if (!base) throw new GitError('当前不在任何分支上（detached HEAD），请指定基础分支');
    if (base.startsWith('-') || !(await branchExists(repo, base)) || !(await tryGit(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]))) {
      throw new GitError(`找不到本地分支「${base}」`);
    }
    let branch = typeof opts.branch === 'string' ? opts.branch.trim() : '';
    if (branch) {
      if (branch.startsWith('-') || !(await git(repo, ['check-ref-format', '--branch', branch]).catch(() => null))) {
        throw new GitError(`「${branch}」不是有效的分支名`);
      }
      if (await branchExists(repo, branch)) throw new GitError(`分支「${branch}」已经存在，换一个名字`);
    } else {
      branch = await autoBranch(repo, opts.agent);
    }
    const dir = await location(repo, branch, opts.roots);
    await mkdir(dirname(dir), { recursive: true });
    await git(repo, ['worktree', 'add', '-b', branch, '--', dir, base], { timeout: 120_000 });
    await restoreModes(dir);
    const copied = await copyLocalFiles(repo, dir).catch(() => []);
    // Started from a subfolder: work in the same subfolder of the worktree.
    const sub = relative(await realpath(repo), await realpath(cwd));
    const sessionCwd = sub && !sub.startsWith('..') && existsSync(join(dir, sub)) ? join(dir, sub) : dir;
    return { meta: { repo, path: dir, branch, base }, cwd: sessionCwd, copied };
  });
}

const count = async (repo: string, range: string) => Number((await tryGit(repo, ['rev-list', '--count', range])) ?? 0);

/** Where a branch is checked out, from `git worktree list --porcelain`. */
async function checkedOutAt(repo: string, branch: string): Promise<string | null> {
  const out = (await tryGit(repo, ['worktree', 'list', '--porcelain'])) ?? '';
  let path: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

const dirty = async (dir: string) => !!(await tryGit(dir, ['status', '--porcelain', '--untracked-files=no']));

export async function worktreeStatus(meta: WorktreeMeta): Promise<WorktreeStatus> {
  const exists = existsSync(meta.path);
  const hasBranch = await branchExists(meta.repo, meta.branch);
  const hasBase = await branchExists(meta.repo, meta.base);
  return {
    branch: meta.branch,
    base: meta.base,
    path: meta.path,
    exists,
    branchExists: hasBranch,
    ahead: hasBranch && hasBase ? await count(meta.repo, `${meta.base}..${meta.branch}`) : 0,
    behind: hasBranch && hasBase ? await count(meta.repo, `${meta.branch}..${meta.base}`) : 0,
    dirty: exists ? await dirty(meta.path) : false,
    untracked: exists ? !!(await tryGit(meta.path, ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory'])) : false,
  };
}

/**
 * Merges the task branch into its base. Where the base is checked out (usually the main
 * working tree) that tree must be clean; a base checked out nowhere is fast-forwarded.
 */
export function mergeWorktree(meta: WorktreeMeta): Promise<string> {
  return locked(meta.repo, async () => {
    if (!(await branchExists(meta.repo, meta.branch))) throw new GitError(`分支 ${meta.branch} 已不存在`);
    if (existsSync(meta.path) && (await dirty(meta.path))) {
      throw new GitError('这个 worktree 里还有没提交的改动，请先在「改动」里提交');
    }
    if ((await count(meta.repo, `${meta.base}..${meta.branch}`)) === 0) throw new GitError(`没有需要合并的提交，${meta.base} 已经包含了这个分支的全部内容`);
    const at = await checkedOutAt(meta.repo, meta.base);
    if (at) {
      if (await dirty(at)) {
        throw new GitError(`${meta.base} 所在的目录（${at}）有没提交的改动，先处理掉再合并`);
      }
      try {
        await git(at, ['merge', '--no-edit', meta.branch], { timeout: 120_000 });
      } catch (e) {
        await tryGit(at, ['merge', '--abort']);
        throw new GitError(
          /CONFLICT|conflict/.test((e as Error).message)
            ? `合并有冲突，已撤销。请让 AI 在这个 worktree 里先把 ${meta.base} 合并进来并解决冲突，再合并回去`
            : (e as Error).message,
        );
      }
      return (await tryGit(at, ['log', '-1', '--format=%h %s'])) ?? '';
    }
    // The base is not checked out anywhere: only a fast-forward is possible without a working tree.
    const ff = await git(meta.repo, ['merge-base', '--is-ancestor', meta.base, meta.branch]).then(() => true, () => false);
    if (!ff) {
      throw new GitError(`${meta.base} 上有这个分支没有的新提交，无法快进。请让 AI 在 worktree 里先合并 ${meta.base}`);
    }
    const [from, to] = await Promise.all([
      git(meta.repo, ['rev-parse', `refs/heads/${meta.base}`]),
      git(meta.repo, ['rev-parse', `refs/heads/${meta.branch}`]),
    ]);
    // With the old value, git refuses if the base moved in the meantime.
    await git(meta.repo, ['update-ref', '-m', `merge ${meta.branch}: fast-forward`, `refs/heads/${meta.base}`, to.trim(), from.trim()]);
    return `${meta.base} 已快进到 ${meta.branch}`;
  });
}

/** Removes the worktree directory and, if asked, its branch. */
export function removeWorktree(meta: WorktreeMeta, opts: { force?: boolean; deleteBranch?: boolean }): Promise<void> {
  return locked(meta.repo, async () => {
    if (existsSync(meta.path)) {
      await git(meta.repo, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), '--', meta.path], { timeout: 120_000 }).catch((e) => {
        throw new GitError(
          /modified or untracked|contains modified/.test((e as Error).message)
            ? '这个 worktree 里有没提交或未跟踪的文件，确认不要了的话请选择强制删除'
            : (e as Error).message,
          'dirty',
        );
      });
    } else {
      await tryGit(meta.repo, ['worktree', 'prune']);
    }
    if (opts.deleteBranch && (await branchExists(meta.repo, meta.branch))) {
      await git(meta.repo, ['branch', opts.force ? '-D' : '-d', meta.branch]).catch((e) => {
        throw new GitError(
          /not fully merged/.test((e as Error).message)
            ? `目录已删除，但分支 ${meta.branch} 还有没合并的提交，所以保留了。确认不要的话请选择强制删除`
            : (e as Error).message,
        );
      });
    }
  });
}
