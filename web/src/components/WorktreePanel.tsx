import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo, WorktreeStatus } from '../../../server/src/shared/protocol';
import { api, ApiError } from '../lib/api';
import { socket } from '../lib/socket';
import { Button, cx, ErrorText, Icon, Modal, shortPath } from './ui';

/** A worktree session's branch: how it compares with its base, merge back, remove. */
export function WorktreePanel({
  session,
  onClose,
  onOpenGit,
}: {
  session: SessionInfo;
  onClose: () => void;
  /** Opens the changes panel (commit, push, pull request). */
  onOpenGit: () => void;
}) {
  const [st, setSt] = useState<WorktreeStatus | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [needForce, setNeedForce] = useState(false);
  const busy = !!working || session.status !== 'idle';

  const load = useCallback(async () => {
    try {
      setSt(await api.worktree(session.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [session.id]);

  useEffect(() => void load(), [load]);

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setWorking(label);
    setError('');
    setDone('');
    try {
      const msg = await fn();
      if (msg) setDone(msg);
    } catch (e) {
      setError((e as Error).message);
      // Uncommitted / untracked files, or an unmerged branch: offer to force it.
      if (label === 'remove' && (e instanceof ApiError) && (e.code === 'dirty' || /强制删除/.test(e.message))) setNeedForce(true);
    } finally {
      setWorking(null);
      void load();
    }
  };

  const merge = () =>
    run('merge', async () => {
      const r = await api.worktreeAction(session.id, 'merge');
      return `已合并到 ${st?.base}：${r.summary ?? ''}`;
    });

  const remove = (force: boolean) => {
    if (!st) return;
    const what = deleteBranch ? `目录和分支 ${st.branch}` : '目录（保留分支）';
    if (!confirm(`${force ? '强制' : ''}删除这个 worktree 的${what}？${force ? '\n未提交的改动和未合并的提交会丢失。' : ''}\n会话的聊天记录会保留，但之后只能查看。`)) return;
    void run('remove', async () => {
      await api.worktreeAction(session.id, 'remove', { force, deleteBranch });
      setNeedForce(false);
      return 'worktree 已删除';
    });
  };

  const syncBase = () => {
    if (!st) return;
    const text = `请把 ${st.base} 分支的最新提交合并到当前分支（${st.branch}），有冲突的话解决冲突后提交。`;
    if (socket.send({ t: 'send', sessionId: session.id, text })) onClose();
    else setError('连接已断开，请稍后重试');
  };

  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Icon name="branch" /> Worktree
        </span>
      }
    >
      <div className="space-y-3 p-4 text-sm">
        {!st && !error && <div className="text-zinc-500">读取中…</div>}
        {st && (
          <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs">{st.branch}</span>
              <span className="text-zinc-500">基于</span>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs">{st.base}</span>
            </div>
            <div className="break-all font-mono text-xs text-zinc-500">{shortPath(st.path)}</div>
            {st.branchExists ? (
              <div className="text-xs text-zinc-300">
                比 {st.base} 多 <b>{st.ahead}</b> 个提交{st.behind > 0 && <>，{st.base} 上有 <b>{st.behind}</b> 个新提交还没合并进来</>}
              </div>
            ) : (
              <div className="text-xs text-zinc-500">分支已删除</div>
            )}
            {!st.exists && <div className="text-xs text-zinc-500">目录已删除，这个会话只能查看历史</div>}
            {st.dirty && <div className="text-xs text-amber-300">有还没提交的改动</div>}
            {st.untracked && <div className="text-xs text-amber-300/80">有未跟踪的文件（删除 worktree 时会一起删掉）</div>}
          </div>
        )}

        {session.status !== 'idle' && <div className="text-xs text-amber-300">AI 正在运行，等它结束后才能合并或删除。</div>}
        <ErrorText>{error}</ErrorText>
        {done && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-200">{done}</div>}

        {st?.exists && (
          <div className="space-y-2">
            <div className="text-xs text-zinc-400">做完了？选一种方式把改动带回去：</div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={merge} disabled={busy || st.ahead === 0 || st.dirty} title={st.dirty ? '先提交改动' : undefined}>
                <Icon name="check" /> {working === 'merge' ? '合并中…' : `合并到 ${st.base}`}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  onClose();
                  onOpenGit();
                }}
              >
                <Icon name="pr" /> 提交 / 推送 / 创建 PR
              </Button>
              {st.behind > 0 && (
                <Button variant="secondary" onClick={syncBase} disabled={busy}>
                  <Icon name="down" /> 让 AI 同步 {st.base}
                </Button>
              )}
            </div>
            {st.dirty && <div className="text-xs text-zinc-500">合并前请先在「提交 / 推送 / 创建 PR」里提交改动。</div>}
          </div>
        )}

        {st && (st.exists || st.branchExists) && (
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" className="accent-emerald-500" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
              同时删除分支 {st.branch}
              {st.ahead > 0 && deleteBranch && <span className="text-amber-300">（还有 {st.ahead} 个提交没合并）</span>}
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" onClick={() => remove(false)} disabled={busy}>
                <Icon name="trash" /> {working === 'remove' ? '删除中…' : st.exists ? '删除 worktree' : '删除分支'}
              </Button>
              {needForce && (
                <Button variant="danger" className={cx('border-red-500/60')} onClick={() => remove(true)} disabled={busy}>
                  强制删除
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
