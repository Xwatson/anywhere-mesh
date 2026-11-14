import { useMemo, useState } from 'react';
import type { AgentKind, OtherSession, SessionInfo } from '../../../server/src/shared/protocol';
import type { User } from '../lib/api';
import { groupByProject } from '../lib/projects';
import { useConnState, useOtherSessions, useOthersAvailable, useSessions, useTerminals } from '../lib/store';
import { HistoryList } from './HistoryList';
import { ProjectGroup } from './ProjectGroup';
import { QuickNew } from './QuickNew';
import { AgentBadge, cx, Icon, RoleBadge, StatusDot } from './ui';
import { UserMenu } from './UserMenu';

type Tab = 'web' | 'others' | 'history';

const TAB_LABELS: Record<Tab, string> = { web: '会话', others: '其他账号', history: '本机历史' };

function savedTab(): Tab {
  try {
    const t = localStorage.getItem('sidebarTab');
    return t === 'history' || t === 'others' ? t : 'web';
  } catch {
    return 'web';
  }
}

export type Route = { kind: 'session' | 'terminal'; id: string } | null;

function relTime(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(ts).toLocaleDateString();
}

/** Admins: every other account's sessions by account, to see what is running and watch it (read-only). */
function OthersList({ route, onNavigate }: { route: Route; onNavigate: (r: Route) => void }) {
  const others = useOtherSessions();
  const available = useOthersAvailable();
  // Accounts in the order of their latest activity (the list comes newest first).
  const groups = useMemo(() => {
    const m = new Map<number, { userId: number; owner: string; items: OtherSession[] }>();
    for (const s of others) {
      let g = m.get(s.userId);
      if (!g) m.set(s.userId, (g = { userId: s.userId, owner: s.owner, items: [] }));
      g.items.push(s);
    }
    return [...m.values()];
  }, [others]);
  const running = groups
    .map((g) => ({ owner: g.owner, n: g.items.filter((s) => s.status !== 'idle').length }))
    .filter((r) => r.n > 0);

  if (!available) return <div className="px-2 py-3 text-sm text-zinc-500">服务端还是旧版本：重启服务后，这里会列出其他账号的会话。</div>;
  return (
    <>
      <div className="px-2 pb-2 text-xs text-zinc-500">
        {running.length ? (
          <span className="text-emerald-300">正在运行：{running.map((r) => `${r.owner} ${r.n} 个`).join('、')}。</span>
        ) : (
          '其他账号现在没有正在运行的会话。'
        )}
        点开可以查看对话（只读）。
      </div>
      {!others.length && <div className="px-2 py-3 text-sm text-zinc-500">其他账号还没有会话。</div>}
      {groups.map((g) => (
        <ProjectGroup
          key={g.userId}
          scope="others"
          project={`user:${g.userId}`}
          name={g.owner}
          hint={`${g.owner} 的会话`}
          icon="users"
          count={g.items.length}
          active={g.items.some((s) => s.status !== 'idle')}
        >
          {g.items.map((s) => {
            // A member's sessions work on its own computer: in the session's project folder, or its home folder.
            const folder = s.remoteCwd ?? (s.member ? '主目录' : s.project);
            return (
              <button
                key={s.id}
                onClick={() => onNavigate({ kind: 'session', id: s.id })}
                className={cx(
                  'mb-0.5 block w-full rounded-lg px-2.5 py-1.5 text-left',
                  route?.kind === 'session' && route.id === s.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/60',
                )}
              >
                <div className="flex items-center gap-2">
                  <StatusDot status={s.status} />
                  <span className="min-w-0 flex-1 truncate text-sm">{s.title}</span>
                  {s.role === 'advisor' ? <RoleBadge /> : <AgentBadge agent={s.agent} />}
                </div>
                <div className="mt-0.5 flex gap-2 pl-4 text-xs text-zinc-500">
                  <span className="min-w-0 flex-1 truncate font-mono" title={folder}>
                    {folder.split('/').filter(Boolean).pop() || folder}
                  </span>
                  <span className="shrink-0">{relTime(s.updatedAt)}</span>
                </div>
              </button>
            );
          })}
        </ProjectGroup>
      ))}
    </>
  );
}

export function Sidebar({
  route,
  user,
  roots,
  home,
  agents,
  onNavigate,
  onNewSession,
  onNewTerminal,
  onLogout,
}: {
  route: Route;
  user: User;
  /** Workspace roots as configured plus symlink-resolved, for "is this path inside a root" checks. */
  roots: string[];
  /** A member's own folder (null for admins). */
  home: string | null;
  /** Installed CLIs, for quick "new session" on a project group. */
  agents: AgentKind[];
  onNavigate: (r: Route) => void;
  onNewSession: () => void;
  onNewTerminal: () => void;
  onLogout: () => void;
}) {
  const sessions = useSessions();
  const others = useOtherSessions();
  const terms = useTerminals();
  const conn = useConnState();
  const [savedTabState, setTabState] = useState<Tab>(savedTab);
  // The machine's CLI history belongs to its owner, and only admins see other accounts: members get just their sessions.
  const tab: Tab = user.isAdmin ? savedTabState : 'web';
  const othersRunning = others.some((s) => s.status !== 'idle');
  const groups = useMemo(() => groupByProject(sessions), [sessions]);
  // Each project's current advisor (the newest one), so the "+" menu opens it rather than making another.
  const advisors = useMemo(() => {
    const m = new Map<string, SessionInfo>();
    for (const s of sessions) {
      if (s.role !== 'advisor') continue;
      const cur = m.get(s.project);
      if (!cur || s.createdAt > cur.createdAt) m.set(s.project, s);
    }
    return m;
  }, [sessions]);

  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem('sidebarTab', t);
    } catch {
      /* storage unavailable */
    }
  };
  const inRoots = (dir: string) => roots.some((r) => dir === r || dir.startsWith(r + '/'));
  const openImported = (s: SessionInfo) => {
    setTab('web');
    onNavigate({ kind: 'session', id: s.id });
  };

  return (
    <nav className="flex h-full flex-col bg-zinc-900">
      <div className="flex items-center gap-2 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="font-mono text-emerald-400">&gt;_</span>
        <span className="font-medium">Anywhere Coding</span>
        <span
          title={conn === 'online' ? '已连接' : conn === 'connecting' ? '连接中' : '已断开'}
          className={cx(
            'ml-auto h-2 w-2 rounded-full',
            conn === 'online' ? 'bg-emerald-400' : conn === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-red-500',
          )}
        />
      </div>

      <div className={cx('grid gap-2 px-3 pb-3 pt-2', user.isAdmin ? 'grid-cols-2' : 'grid-cols-1')}>
        <button
          onClick={onNewSession}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400"
        >
          <Icon name="plus" /> 新会话
        </button>
        {/* A raw terminal has all of this machine's rights: admins only. */}
        {user.isAdmin && (
          <button
            onClick={onNewTerminal}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 py-2 text-sm hover:bg-zinc-800"
          >
            <Icon name="terminal" /> 终端
          </button>
        )}
      </div>

      {user.isAdmin && (
        <div className="mx-3 grid grid-cols-3 rounded-lg bg-zinc-950 p-0.5 text-sm">
          {(['web', 'others', 'history'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              title={t === 'others' ? (othersRunning ? '其他账号有会话正在运行' : '其他账号的会话（只读）') : undefined}
              className={cx(
                'flex items-center justify-center gap-1 rounded-md py-1',
                tab === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              {TAB_LABELS[t]}
              {t === 'others' && othersRunning && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
            </button>
          ))}
        </div>
      )}

      {tab === 'history' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          <HistoryList roots={roots} agents={agents} onOpen={openImported} />
        </div>
      ) : tab === 'others' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
          <OthersList route={route} onNavigate={onNavigate} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
          {!sessions.length && (
            <div className="px-2 py-3 text-sm text-zinc-500">
              {user.isAdmin
                ? '还没有会话。新建一个，或从「本机历史」打开 CLI 里的会话继续。'
                : '还没有会话。点上面的「新会话」开始，AI 会通过 SSH 在你自己的电脑上工作。'}
            </div>
          )}
          {groups.map((g) => (
            <ProjectGroup
              key={g.project}
              scope="web"
              project={g.project}
              name={g.name}
              count={g.items.length}
              active={g.items.some((s) => s.status !== 'idle')}
              actions={
                // A member's groups are projects on its own computer (or its folder here, for sessions from before projects).
                (user.isAdmin ? inRoots(g.project) : true) && (
                  <QuickNew
                    project={g.project}
                    agents={agents}
                    member={!user.isAdmin}
                    remoteProject={!user.isAdmin && g.project !== home}
                    advisor={advisors.get(g.project)}
                    onCreated={(s) => onNavigate({ kind: 'session', id: s.id })}
                  />
                )
              }
            >
              {g.items.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onNavigate({ kind: 'session', id: s.id })}
                  className={cx(
                    'mb-0.5 block w-full rounded-lg px-2.5 py-1.5 text-left',
                    route?.kind === 'session' && route.id === s.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/60',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={s.status} />
                    <span className={cx('min-w-0 flex-1 truncate text-sm', !s.inWorkspace && 'text-zinc-400')}>{s.title}</span>
                    {s.role === 'advisor' ? <RoleBadge /> : <AgentBadge agent={s.agent} />}
                  </div>
                  <div className="mt-0.5 flex gap-2 pl-4 text-xs text-zinc-500">
                    {/* Show the subfolder only when it differs from the project root. */}
                    <span className="flex min-w-0 flex-1 items-center gap-1 truncate font-mono">
                      {s.worktree ? (
                        <>
                          <Icon name="branch" className={cx('h-3 w-3', s.worktree.exists ? 'text-emerald-500/80' : 'text-zinc-600')} />
                          <span className={cx('truncate', !s.worktree.exists && 'line-through')}>{s.worktree.branch}</span>
                        </>
                      ) : (
                        s.subdir
                      )}
                    </span>
                    {!s.inWorkspace && <span className="shrink-0 text-amber-500/80">只读</span>}
                    <span className="shrink-0">{relTime(s.updatedAt)}</span>
                  </div>
                </button>
              ))}
            </ProjectGroup>
          ))}

          {terms.length > 0 && <div className="px-2 pb-1 pt-4 text-xs text-zinc-500">终端</div>}
          {terms.map((t) => (
            <button
              key={t.id}
              onClick={() => onNavigate({ kind: 'terminal', id: t.id })}
              className={cx(
                'mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm',
                route?.kind === 'terminal' && route.id === t.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/60',
              )}
            >
              <Icon name="terminal" className={t.exited ? 'text-zinc-600' : 'text-emerald-400'} />
              <span className={cx('truncate', t.exited && 'text-zinc-500 line-through')}>{t.title}</span>
            </button>
          ))}
        </div>
      )}

      <UserMenu user={user} onLogout={onLogout} />
    </nav>
  );
}
