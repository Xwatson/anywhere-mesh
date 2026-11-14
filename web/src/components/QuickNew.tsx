import { useEffect, useRef, useState } from 'react';
import type { AgentKind, SessionInfo, SessionOptions } from '../../../server/src/shared/protocol';
import { api } from '../lib/api';
import { addSession } from '../lib/store';
import { cx, Icon } from './ui';

/**
 * Settings for sessions started from the "+" menu. Claude gets auto-approval,
 * Opus 5.5 (Claude Code's "opus" alias) and high effort; Codex gets full access.
 */
const QUICK_OPTIONS: Record<AgentKind, SessionOptions> = {
  claude: { permissionMode: 'auto', model: 'opus', effort: 'high' },
  codex: { sandboxMode: 'danger-full-access' },
};

/**
 * "+" on a project group: start a session in that folder with preset settings
 * (model, effort and permissions can be changed afterwards from the input bar).
 */
export function QuickNew({
  project,
  agents,
  advisor,
  member,
  remoteProject,
  onCreated,
}: {
  project: string;
  agents: AgentKind[];
  /** The project's product advisor when it already has one: the menu opens it instead of creating another. */
  advisor?: SessionInfo;
  /** A member account: its sessions work on its own computer (no worktree, no steward here). */
  member?: boolean;
  /** Member: the group is a project folder on the member's computer (not its folder on this server). */
  remoteProject?: boolean;
  onCreated: (s: SessionInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Whether the folder is a git repository, so worktree sessions can be offered. */
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || isRepo !== null) return;
    if (member) return setIsRepo(false);
    api.branches(project).then(
      () => setIsRepo(true),
      () => setIsRepo(false),
    );
  }, [open, isRepo, project, member]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const create = async (agent: AgentKind, worktree = false, role?: 'advisor') => {
    setBusy(true);
    setError('');
    try {
      const s = role
        ? await api.createSession({ agent: 'claude', cwd: project, role, options: {} })
        : await api.createSession({
            agent,
            cwd: project,
            options: QUICK_OPTIONS[agent],
            worktree: worktree ? {} : undefined,
            // A member's groups are projects on the member's computer (the group of its folder here: its home there).
            ...(member && remoteProject && { remoteCwd: project }),
          });
      addSession(s);
      setOpen(false);
      onCreated(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openAdvisor = () => {
    if (!advisor) return void create('claude', false, 'advisor');
    setOpen(false);
    onCreated(advisor);
  };

  if (!agents.length) return null;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={busy}
        className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400 disabled:opacity-50"
        title="在这个目录新建会话"
        aria-label="在这个目录新建会话"
      >
        <Icon name={busy ? 'refresh' : 'plus'} className={cx('h-3.5 w-3.5', busy && 'animate-spin')} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm shadow-xl">
          {agents.map((a) => (
            <button
              key={a}
              onClick={() => create(a)}
              disabled={busy}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800 disabled:opacity-50"
            >
              <span className={cx('h-2 w-2 shrink-0 rounded-full', a === 'claude' ? 'bg-claude' : 'bg-codex')} />
              <span className="min-w-0">
                新建 {a === 'claude' ? 'Claude' : 'Codex'} 会话
                {a === 'claude' && <span className="block truncate text-xs text-zinc-500">智能审批 · Opus 5.5 · 高推理</span>}
              </span>
            </button>
          ))}
          {isRepo &&
            agents.map((a) => (
              <button
                key={`wt-${a}`}
                onClick={() => create(a, true)}
                disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800 disabled:opacity-50"
                title="新建分支和单独的目录，和其他会话互不干扰"
              >
                <Icon name="branch" className={cx('h-3.5 w-3.5', a === 'claude' ? 'text-claude' : 'text-codex')} />
                {a === 'claude' ? 'Claude' : 'Codex'}：新 worktree
              </button>
            ))}
          {agents.includes('claude') && !member && (
            <>
              <div className="my-1 border-t border-zinc-800" />
              <button
                onClick={openAdvisor}
                disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800 disabled:opacity-50"
                title={advisor ? '打开这个项目的管家' : '一个全权推进项目的 AI 角色：拿主意、排活、验收、合并，只在拿不到的东西和甲方拍板上找你'}
              >
                <Icon name="compass" className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                <span className="min-w-0">
                  {advisor ? '打开管家' : '新建管家'}
                  {!advisor && <span className="block truncate text-xs text-zinc-500">替你拿主意、排活、验收，一直迭代</span>}
                </span>
              </button>
            </>
          )}
          {error && <div className="px-3 py-1.5 text-xs text-red-400">{error}</div>}
        </div>
      )}
    </div>
  );
}
