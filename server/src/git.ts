// Git operations offered in the web UI: status, commit, push, pull, branches and pull requests.
// Every command runs through execFile with an argument list (never a shell).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitFile, GitInfo } from './shared/protocol.js';

const exec = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    /** Lets the UI react, e.g. ask for an author when none is configured. */
    public code?: 'identity' | 'nothing' | 'detached' | 'no-remote' | 'dirty',
  ) {
    super(message);
  }
}

// Network operations must fail instead of waiting for a password prompt nobody can answer.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };

export async function git(cwd: string, args: string[], opts: { input?: string; timeout?: number } = {}): Promise<string> {
  try {
    const child = exec('git', args, { cwd, env: ENV, maxBuffer: 20 * 1024 * 1024, timeout: opts.timeout ?? 30_000 });
    if (opts.input !== undefined) {
      child.child.stdin?.end(opts.input);
    } else {
      child.child.stdin?.end();
    }
    return (await child).stdout;
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; killed?: boolean; message: string };
    if (err.killed) throw new GitError(`git ${args[0]} 超时`);
    const text = (err.stderr || err.stdout || err.message).trim();
    throw new GitError(text.replace(/^error: |^fatal: /gm, ''));
  }
}

export const tryGit = (cwd: string, args: string[]) => git(cwd, args).then((s) => s.trim()).catch(() => null);

// ---------------------------------------------------------------- per-repo lock

const locks = new Map<string, Promise<unknown>>();

/** Runs git operations on one repository one after another. */
export function locked<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(cwd) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(cwd, next);
  void next.finally(() => locks.get(cwd) === next && locks.delete(cwd)).catch(() => {});
  return next;
}

// ---------------------------------------------------------------- status

/** Parses `git status --porcelain=v1 -z`. */
function parseStatus(out: string): GitFile[] {
  const parts = out.split('\0');
  const files: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    let from: string | undefined;
    if (x === 'R' || x === 'C') from = parts[++i];
    const code = x === '?' ? 'untracked' : x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D') ? 'conflict'
      : x === 'R' || y === 'R' ? 'renamed' : x === 'A' ? 'added' : x === 'D' || y === 'D' ? 'deleted' : 'modified';
    files.push({ path, from, status: code, staged: x !== ' ' && x !== '?' });
  }
  return files;
}

interface Remote {
  name: string;
  url: string;
}

/** Web page for opening a pull/merge request, for GitHub, GitLab and GitHub-like hosts (Gitea, Forgejo). */
export function compareUrl(remoteUrl: string, base: string, head: string): string | null {
  const m =
    remoteUrl.match(/^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/) || // git@host:owner/repo.git
    remoteUrl.match(/^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const [, host, path] = m;
  const enc = encodeURIComponent;
  if (/gitlab/i.test(host)) {
    return `https://${host}/${path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${enc(head)}&merge_request%5Btarget_branch%5D=${enc(base)}`;
  }
  // Branch names keep their slashes in the path (feat/x), the rest is escaped.
  const seg = (b: string) => enc(b).replace(/%2F/g, '/');
  return `https://${host}/${path}/compare/${seg(base)}...${seg(head)}?expand=1`;
}

let ghCache: { at: number; ok: boolean } | null = null;

/** Whether the GitHub CLI is installed and logged in (cached for a minute). */
async function ghReady(): Promise<boolean> {
  if (ghCache && Date.now() - ghCache.at < 60_000) return ghCache.ok;
  const ok = await exec('gh', ['auth', 'status'], { env: ENV, timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  ghCache = { at: Date.now(), ok };
  return ok;
}

export async function remotes(cwd: string): Promise<Remote[]> {
  const out = (await tryGit(cwd, ['remote', '-v'])) ?? '';
  const seen = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

async function defaultBranch(cwd: string, remote: string | undefined): Promise<string> {
  if (remote) {
    const head = await tryGit(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
    if (head) return head.slice(remote.length + 1);
  }
  for (const b of ['main', 'master']) {
    if (await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  }
  return 'main';
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  const root = await tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return { isGit: false };
  const [status, branch, head, upstream, name, email, lastAuthor, lastSubject, rems] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-z', '-uall']),
    tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']),
    tryGit(cwd, ['rev-parse', '--short', 'HEAD']),
    tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    tryGit(cwd, ['config', 'user.name']),
    tryGit(cwd, ['config', 'user.email']),
    tryGit(cwd, ['log', '-1', '--format=%an%x00%ae']),
    tryGit(cwd, ['log', '-1', '--format=%s']),
    remotes(cwd),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await tryGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
    [ahead, behind] = (counts ?? '0 0').split(/\s+/).map(Number);
  } else if (branch && head) {
    // Not pushed yet: everything on this branch that no remote branch has.
    ahead = Number((await tryGit(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])) ?? 0);
  }
  const remote = rems.find((r) => r.name === 'origin') ?? rems[0];
  const base = await defaultBranch(cwd, remote?.name);
  const [author, authorEmail] = (lastAuthor ?? '').split('\0');
  return {
    isGit: true,
    root,
    branch,
    head,
    upstream,
    ahead,
    behind,
    remote: remote?.name ?? null,
    defaultBranch: base,
    files: parseStatus(status),
    identity: name && email ? { name, email } : null,
    suggestedIdentity: author && authorEmail ? { name: author, email: authorEmail } : null,
    lastSubject,
    prUrl: remote && branch && branch !== base ? compareUrl(remote.url, base, branch) : null,
    gh: remote ? await ghReady() : false,
  };
}

// ---------------------------------------------------------------- actions

const cleanPaths = (files: unknown): string[] | null => {
  if (files === undefined || files === null) return null;
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string' && f && !f.includes('\0'))) {
    throw new GitError('文件列表无效');
  }
  return files as string[];
};

/** Commits the given paths (all changes when omitted). */
export function commit(cwd: string, message: string, files?: unknown): Promise<string> {
  return locked(cwd, async () => {
    const msg = message.trim();
    if (!msg) throw new GitError('请填写提交信息');
    const paths = cleanPaths(files);
    if (paths && !paths.length) throw new GitError('没有选择要提交的文件', 'nothing');
    const name = await tryGit(cwd, ['config', 'user.name']);
    const email = await tryGit(cwd, ['config', 'user.email']);
    if (!name || !email) throw new GitError('这个仓库还没有设置提交者（user.name / user.email）', 'identity');
    // `--` everywhere: file names can never be read as options.
    if (paths) {
      await git(cwd, ['add', '-A', '--', ...paths]);
      await git(cwd, ['commit', '-F', '-', '--', ...paths], { input: msg });
    } else {
      await git(cwd, ['add', '-A']);
      const staged = await git(cwd, ['diff', '--cached', '--name-only']);
      if (!staged.trim()) throw new GitError('没有可以提交的改动', 'nothing');
      await git(cwd, ['commit', '-F', '-'], { input: msg });
    }
    return (await tryGit(cwd, ['log', '-1', '--format=%h %s'])) ?? '';
  });
}

/** Sets the author for this repository only (git config, not --global). */
export function setIdentity(cwd: string, name: unknown, email: unknown): Promise<void> {
  return locked(cwd, async () => {
    const n = typeof name === 'string' ? name.trim() : '';
    const e = typeof email === 'string' ? email.trim() : '';
    if (!n || n.length > 100 || /[\n<>]/.test(n)) throw new GitError('名字无效');
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(e) || e.length > 200) throw new GitError('邮箱无效');
    await git(cwd, ['config', 'user.name', n]);
    await git(cwd, ['config', 'user.email', e]);
  });
}

async function pushNow(cwd: string): Promise<string> {
  const branch = await tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!branch) throw new GitError('当前不在任何分支上（detached HEAD），无法推送', 'detached');
  const upstream = await tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  // git prints progress and the result on stderr.
  const run = (args: string[]) =>
    exec('git', args, { cwd, env: ENV, timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }).then(
      (r) => (r.stderr + r.stdout).trim(),
      (e: { stderr?: string; killed?: boolean; message: string }) => {
        throw new GitError(e.killed ? 'git push 超时（检查网络或代理）' : (e.stderr || e.message).trim());
      },
    );
  if (upstream) return run(['push']);
  const rems = await remotes(cwd);
  const remote = rems.find((r) => r.name === 'origin') ?? rems[0];
  if (!remote) throw new GitError('这个仓库没有配置远程仓库（git remote）', 'no-remote');
  return run(['push', '-u', remote.name, branch]);
}

export const push = (cwd: string) => locked(cwd, () => pushNow(cwd));

export function pull(cwd: string): Promise<string> {
  return locked(cwd, async () => {
    try {
      const r = await exec('git', ['pull', '--ff-only'], { cwd, env: ENV, timeout: 120_000, maxBuffer: 5 * 1024 * 1024 });
      return (r.stdout + r.stderr).trim();
    } catch (e) {
      const err = e as { stderr?: string; killed?: boolean; message: string };
      if (err.killed) throw new GitError('git pull 超时（检查网络或代理）');
      const text = (err.stderr || err.message).trim();
      throw new GitError(
        /Not possible to fast-forward|diverged/i.test(text)
          ? '本地和远程都有新提交，无法直接快进。请让 AI 帮你合并（rebase 或 merge）'
          : text,
      );
    }
  });
}

/** Creates a branch from the current commit and switches to it; uncommitted changes come along. */
export function createBranch(cwd: string, name: unknown): Promise<string> {
  return locked(cwd, async () => {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n || n.startsWith('-')) throw new GitError('分支名无效');
    const ok = await git(cwd, ['check-ref-format', '--branch', n]).catch(() => null);
    if (!ok) throw new GitError(`「${n}」不是有效的分支名`);
    await git(cwd, ['switch', '-c', n]);
    return n;
  });
}

/**
 * Pushes the branch if needed, then opens the pull request with the GitHub CLI when it is
 * logged in; otherwise returns the hosting site's "new pull request" page.
 */
export function createPr(cwd: string, title: unknown, body: unknown, base: unknown): Promise<{ url: string; created: boolean }> {
  return locked(cwd, async () => {
    const info = await gitInfo(cwd);
    if (!info.isGit) throw new GitError('不是 git 仓库');
    if (!info.branch) throw new GitError('当前不在任何分支上（detached HEAD）', 'detached');
    if (!info.remote) throw new GitError('这个仓库没有配置远程仓库（git remote）', 'no-remote');
    const target = typeof base === 'string' && base.trim() ? base.trim() : info.defaultBranch;
    if (info.branch === target) throw new GitError(`当前就在 ${target} 分支上，请先新建一个分支再创建 PR`);
    if (!info.upstream || info.ahead > 0) await pushNow(cwd);
    if (info.gh) {
      const t = typeof title === 'string' && title.trim() ? title.trim() : (info.lastSubject ?? info.branch);
      const b = typeof body === 'string' ? body : '';
      try {
        const r = await exec('gh', ['pr', 'create', '--title', t, '--body', b, '--base', target, '--head', info.branch], {
          cwd,
          env: ENV,
          timeout: 60_000,
        });
        const url = r.stdout.trim().split('\n').pop() ?? '';
        return { url, created: true };
      } catch (e) {
        const text = ((e as { stderr?: string }).stderr ?? (e as Error).message).trim();
        // Already exists: gh prints its URL.
        const existing = text.match(/https:\/\/\S+\/pull\/\d+/);
        if (existing) return { url: existing[0], created: false };
        throw new GitError(text);
      }
    }
    const rems = await remotes(cwd);
    const url = compareUrl(rems.find((r) => r.name === info.remote)!.url, target, info.branch);
    if (!url) throw new GitError('无法识别远程仓库的地址，请手动创建 PR');
    return { url, created: false };
  });
}
