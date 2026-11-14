import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GitFile, GitInfo, SessionInfo } from '../../../server/src/shared/protocol';
import { api, ApiError, type DiffResult } from '../lib/api';
import { socket } from '../lib/socket';
import { Button, cx, ErrorText, Icon, Modal } from './ui';

interface FileDiff {
  path: string;
  lines: string[];
  added: number;
  removed: number;
}

function parseDiff(diff: string): Map<string, FileDiff> {
  const files = new Map<string, FileDiff>();
  let cur: FileDiff | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.*)$/);
      cur = { path: m?.[1] ?? line, lines: [], added: 0, removed: 0 };
      files.set(cur.path, cur);
      continue;
    }
    if (!cur) continue;
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(line)) continue;
    cur.lines.push(line);
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
  }
  return files;
}

const STATUS: Record<GitFile['status'], { letter: string; cls: string; label: string }> = {
  modified: { letter: 'M', cls: 'text-amber-300', label: '已修改' },
  added: { letter: 'A', cls: 'text-emerald-300', label: '新增' },
  untracked: { letter: 'U', cls: 'text-emerald-300', label: '新文件（未跟踪）' },
  deleted: { letter: 'D', cls: 'text-red-300', label: '已删除' },
  renamed: { letter: 'R', cls: 'text-sky-300', label: '重命名' },
  conflict: { letter: '!', cls: 'text-red-400', label: '有冲突' },
};

function FileBlock({
  file,
  diff,
  checked,
  onCheck,
  disabled,
}: {
  file: GitFile;
  diff?: FileDiff;
  checked: boolean;
  onCheck: (on: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const st = STATUS[file.status];
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800">
      <div className="flex items-center gap-2 bg-zinc-900 px-2 py-1.5 text-sm">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onCheck(e.target.checked)}
          className="h-4 w-4 shrink-0 accent-emerald-500"
          aria-label={`提交 ${file.path}`}
        />
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left">
          <Icon name="chevron" className={cx('text-zinc-500 transition-transform', open && 'rotate-90')} />
          <span className={cx('w-3 shrink-0 text-center font-mono text-xs font-bold', st.cls)} title={st.label}>
            {st.letter}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.from ? `${file.from} → ${file.path}` : file.path}>
            {file.from && <span className="text-zinc-500">{file.from} → </span>}
            {file.path}
          </span>
          {diff && (
            <>
              <span className="text-xs text-emerald-400">+{diff.added}</span>
              <span className="text-xs text-red-400">-{diff.removed}</span>
            </>
          )}
        </button>
      </div>
      {open && (
        <pre className="max-h-[60vh] overflow-auto bg-zinc-950 py-1 font-mono text-xs leading-5">
          {!diff?.lines.length && <div className="px-3 text-zinc-500">没有可显示的文本改动</div>}
          {diff?.lines.map((l, i) => (
            <div
              key={i}
              className={cx(
                'px-3 whitespace-pre',
                l.startsWith('+') && 'bg-emerald-500/10 text-emerald-300',
                l.startsWith('-') && 'bg-red-500/10 text-red-300',
                l.startsWith('@@') && 'text-sky-400/80',
                l.startsWith('Binary') && 'text-zinc-500',
              )}
            >
              {l || ' '}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

type Repo = Extract<GitInfo, { isGit: true }>;
type Panel = null | 'branch' | 'pr' | 'identity';

const input =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500 disabled:opacity-50';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

/** Changes in the session's repository, with commit, push, pull, branch and pull request. */
export function DiffView({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; link?: string; mono?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [branchName, setBranchName] = useState('');
  const [pr, setPr] = useState({ title: '', body: '', base: '' });
  const [who, setWho] = useState({ name: '', email: '' });
  const readOnly = !session.inWorkspace;
  /** Paths seen in the previous load, to tell new files (selected by default) from unticked ones. */
  const known = useRef(new Set<string>());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, d] = await Promise.all([api.git(session.id), api.diff(session.id)]);
      setInfo(g);
      setDiff(d);
      setError('');
      if (g.isGit) {
        // New files start selected; files the user unticked stay unticked.
        setSelected((cur) => {
          const next = new Set<string>();
          for (const f of g.files) if (cur.has(f.path) || !known.current.has(f.path)) next.add(f.path);
          known.current = new Set(g.files.map((f) => f.path));
          return next;
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => void load(), [load]);

  const diffs = useMemo(() => (diff ? parseDiff(diff.diff) : new Map<string, FileDiff>()), [diff]);
  const repo = info?.isGit ? (info as Repo) : null;
  const files = repo?.files ?? [];
  const picked = files.filter((f) => selected.has(f.path));
  const allPicked = files.length > 0 && picked.length === files.length;

  /** Runs a git action and reloads; returns the response, or null when it failed. */
  const act = async <T,>(label: string, action: Parameters<typeof api.gitAction>[1], body: object = {}) => {
    setWorking(label);
    setError('');
    setNotice(null);
    try {
      return await api.gitAction<T>(session.id, action, body);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'identity') {
        setWho(repo?.suggestedIdentity ?? { name: '', email: '' });
        setPanel('identity');
      }
      setError((e as Error).message);
      return null;
    } finally {
      setWorking(null);
      void load();
    }
  };

  const doCommit = async () => {
    const r = await act<{ summary: string }>('commit', 'commit', {
      message,
      // Everything selected: let git pick up all changes (also ones listed under another path).
      files: allPicked ? undefined : picked.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])),
    });
    if (r) {
      setMessage('');
      setNotice({ text: `已提交：${r.summary}` });
    }
  };

  const doPush = async () => {
    const r = await act<{ output: string }>('push', 'push');
    if (r) setNotice({ text: r.output || '已推送', mono: true });
  };

  const doPull = async () => {
    const r = await act<{ output: string }>('pull', 'pull');
    if (r) setNotice({ text: r.output || '已是最新', mono: true });
  };

  const doBranch = async () => {
    const r = await act<{ branch: string }>('branch', 'branch', { name: branchName });
    if (r) {
      setPanel(null);
      setBranchName('');
      setNotice({ text: `已切换到新分支 ${r.branch}（未提交的改动也一起带过来了）` });
    }
  };

  const doPr = async () => {
    const r = await act<{ url: string; created: boolean }>('pr', 'pr', pr);
    if (r) {
      setPanel(null);
      setNotice(
        r.created
          ? { text: 'PR 已创建', link: r.url }
          : { text: repo?.gh ? '这个分支已经有 PR 了' : '分支已推送，点下面的链接在网页上填写并创建 PR', link: r.url },
      );
    }
  };

  const doIdentity = async () => {
    const r = await act('identity', 'identity', who);
    if (r) {
      setPanel(null);
      setNotice({ text: `已为这个仓库设置提交者：${who.name} <${who.email}>，可以提交了` });
    }
  };

  const askAi = () => {
    const text =
      '请查看当前仓库的 git 改动，写一条简洁准确的提交信息并提交（只提交，不要推送）。' +
      (allPicked || !picked.length ? '' : `只提交这些文件：${picked.map((f) => f.path).join('、')}`);
    if (socket.send({ t: 'send', sessionId: session.id, text })) onClose();
    else setError('连接已断开，请稍后重试');
  };

  const openPr = () => {
    if (!repo) return;
    setPr({ title: repo.lastSubject ?? '', body: '', base: repo.defaultBranch });
    setPanel(panel === 'pr' ? null : 'pr');
  };

  const onDefault = !!repo && repo.branch === repo.defaultBranch;
  const busy = !!working;

  return (
    <Modal
      wide
      onClose={onClose}
      title={
        <span className="flex flex-wrap items-center gap-2">
          改动与提交
          {repo && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-300">
              {repo.branch ?? `(detached ${repo.head})`}
            </span>
          )}
          {repo && (repo.ahead > 0 || repo.behind > 0) && (
            <span className="text-xs tabular-nums text-zinc-400" title="本地领先 / 落后远程的提交数">
              {repo.ahead > 0 && `↑${repo.ahead}`} {repo.behind > 0 && `↓${repo.behind}`}
            </span>
          )}
        </span>
      }
    >
      <div className="space-y-3 p-3 sm:p-4">
        {repo && !readOnly && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="secondary" className="py-1.5" onClick={doPull} disabled={busy || !repo.upstream} title={repo.upstream ? `从 ${repo.upstream} 拉取（只快进）` : '这个分支还没有上游分支'}>
              <Icon name="down" className={working === 'pull' ? 'animate-bounce' : ''} /> 拉取{repo.behind > 0 && ` ${repo.behind}`}
            </Button>
            <Button
              variant="secondary"
              className="py-1.5"
              onClick={doPush}
              disabled={busy || !repo.branch || !repo.remote || (repo.ahead === 0 && !!repo.upstream)}
              title={!repo.remote ? '没有配置远程仓库' : repo.upstream ? `推送到 ${repo.upstream}` : `首次推送到 ${repo.remote}/${repo.branch}`}
            >
              <Icon name="up" className={working === 'push' ? 'animate-bounce' : ''} /> 推送{repo.ahead > 0 && ` ${repo.ahead}`}
            </Button>
            <Button variant="secondary" className="py-1.5" onClick={() => setPanel(panel === 'branch' ? null : 'branch')} disabled={busy}>
              <Icon name="branch" /> 新建分支
            </Button>
            <Button variant="secondary" className="py-1.5" onClick={openPr} disabled={busy || !repo.remote || !repo.branch}>
              <Icon name="pr" /> 创建 PR
            </Button>
            <span className="flex-1" />
            <Button variant="ghost" className="py-1.5" onClick={load} disabled={loading}>
              <Icon name="refresh" className={loading ? 'animate-spin' : ''} /> 刷新
            </Button>
          </div>
        )}

        {session.status !== 'idle' && repo && !readOnly && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            AI 还在运行，可能还会继续修改文件，建议等它结束后再提交。
          </div>
        )}
        <ErrorText>{error}</ErrorText>
        {notice && (
          <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            <div className={cx('whitespace-pre-wrap break-words', notice.mono && 'font-mono text-xs')}>{notice.text}</div>
            {notice.link && (
              <a href={notice.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-emerald-950 hover:bg-emerald-400">
                打开 PR 页面 ↗
              </a>
            )}
          </div>
        )}

        {panel === 'identity' && (
          <div className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <div className="text-sm">设置提交者（只对这个仓库生效，写入 .git/config）</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="名字">
                <input className={input} value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} />
              </Field>
              <Field label="邮箱">
                <input className={input} type="email" value={who.email} onChange={(e) => setWho({ ...who, email: e.target.value })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPanel(null)}>取消</Button>
              <Button variant="primary" onClick={doIdentity} disabled={busy || !who.name.trim() || !who.email.trim()}>保存</Button>
            </div>
          </div>
        )}

        {panel === 'branch' && repo && (
          <div className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <Field label={`从当前提交（${repo.branch ?? repo.head}）新建分支并切换过去，未提交的改动会一起带过去`}>
              <input
                className={cx(input, 'font-mono')}
                value={branchName}
                autoFocus
                placeholder="例如 feat/web-git"
                onChange={(e) => setBranchName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && branchName.trim() && void doBranch()}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPanel(null)}>取消</Button>
              <Button variant="primary" onClick={doBranch} disabled={busy || !branchName.trim()}>创建并切换</Button>
            </div>
          </div>
        )}

        {panel === 'pr' && repo && (
          <div className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            {onDefault ? (
              <div className="text-sm text-amber-200">
                当前就在 {repo.defaultBranch} 分支上。先「新建分支」把改动放到新分支上，再创建 PR。
              </div>
            ) : (
              <>
                <div className="text-xs text-zinc-400">
                  {repo.branch} → 合并到下面的目标分支。{!repo.upstream || repo.ahead > 0 ? '会先推送这个分支。' : ''}
                  {repo.gh ? '将用 GitHub CLI 直接创建。' : '本机没有登录 GitHub CLI（gh），推送后会给你一个链接，在网页上完成创建。'}
                </div>
                <Field label="目标分支">
                  <input className={cx(input, 'font-mono')} value={pr.base} onChange={(e) => setPr({ ...pr, base: e.target.value })} />
                </Field>
                {repo.gh && (
                  <>
                    <Field label="标题">
                      <input className={input} value={pr.title} onChange={(e) => setPr({ ...pr, title: e.target.value })} />
                    </Field>
                    <Field label="描述">
                      <textarea className={cx(input, 'min-h-[80px] resize-y')} value={pr.body} onChange={(e) => setPr({ ...pr, body: e.target.value })} />
                    </Field>
                  </>
                )}
                {files.length > 0 && <div className="text-xs text-amber-300">还有 {files.length} 个文件没提交，PR 里不会包含它们。</div>}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setPanel(null)}>取消</Button>
                  <Button variant="primary" onClick={doPr} disabled={busy || !pr.base.trim()}>
                    {working === 'pr' ? '处理中…' : repo.gh ? '创建 PR' : '推送并获取 PR 链接'}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {repo && files.length > 0 && !readOnly && (
          <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
            <textarea
              className={cx(input, 'min-h-[64px] resize-y')}
              placeholder="提交信息"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && message.trim() && picked.length && void doCommit()}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" onClick={askAi} disabled={busy || session.status !== 'idle'} title="把「写提交信息并提交」交给当前会话的 AI">
                让 AI 写提交信息并提交
              </Button>
              <Button variant="primary" onClick={doCommit} disabled={busy || !message.trim() || !picked.length}>
                <Icon name="check" /> {working === 'commit' ? '提交中…' : `提交 ${picked.length} 个文件`}
              </Button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 text-sm text-zinc-400">
          {repo && files.length > 0 && !readOnly && (
            <input
              type="checkbox"
              checked={allPicked}
              ref={(el) => {
                if (el) el.indeterminate = picked.length > 0 && !allPicked;
              }}
              onChange={(e) => setSelected(e.target.checked ? new Set(files.map((f) => f.path)) : new Set())}
              className="ml-2 h-4 w-4 accent-emerald-500"
              aria-label="全选"
            />
          )}
          <span className="flex-1">
            {repo ? `${files.length} 个文件有改动（相对 HEAD，含未跟踪文件）` : info ? '该目录不是 git 仓库' : ''}
          </span>
          {(readOnly || !repo) && (
            <Button variant="ghost" onClick={load} disabled={loading}>
              <Icon name="refresh" className={loading ? 'animate-spin' : ''} /> 刷新
            </Button>
          )}
        </div>
        {repo && !files.length && !loading && <div className="py-10 text-center text-zinc-500">没有未提交的改动</div>}
        {files.map((f) => (
          <FileBlock
            key={f.path}
            file={f}
            diff={diffs.get(f.path)}
            checked={selected.has(f.path)}
            disabled={readOnly}
            onCheck={(on) =>
              setSelected((cur) => {
                const next = new Set(cur);
                if (on) next.add(f.path);
                else next.delete(f.path);
                return next;
              })
            }
          />
        ))}
      </div>
    </Modal>
  );
}
