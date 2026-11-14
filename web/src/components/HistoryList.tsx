import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentKind, ExternalSession, SessionInfo } from '../../../server/src/shared/protocol';
import { api } from '../lib/api';
import { groupByProject } from '../lib/projects';
import { addSession } from '../lib/store';
import { ProjectGroup } from './ProjectGroup';
import { QuickNew } from './QuickNew';
import { AgentBadge, cx, ErrorText, Icon } from './ui';

const POLL_MS = 30_000;

function relDay(ts: number) {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

/** Sessions Claude Code / Codex stored on this machine (CLI, IDE, …), openable in the web UI. */
export function HistoryList({
  roots,
  agents,
  onOpen,
}: {
  roots: string[];
  agents: AgentKind[];
  onOpen: (s: SessionInfo) => void;
}) {
  const [items, setItems] = useState<ExternalSession[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<AgentKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.history());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (s) => (filter === 'all' || s.agent === filter) && (!q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)),
    );
  }, [items, filter, query]);

  const open = async (s: ExternalSession) => {
    setOpening(`${s.agent}:${s.id}`);
    try {
      const info = await api.importHistory(s.agent, s.id);
      addSession(info);
      onOpen(info);
      void load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(null);
    }
  };

  const inWorkspace = (cwd: string) => roots.some((r) => cwd === r || cwd.startsWith(r + '/'));
  const groups = useMemo(() => groupByProject(shown), [shown]);

  return (
    <div className="space-y-2">
      <div className="space-y-2 px-2 pt-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索标题或目录"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <div className="flex items-center gap-1">
          {(['all', 'claude', 'codex'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cx(
                'rounded-full px-2.5 py-0.5 text-xs',
                filter === f ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800',
              )}
            >
              {f === 'all' ? '全部' : f === 'claude' ? 'Claude' : 'Codex'}
            </button>
          ))}
          <button onClick={load} className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="刷新" aria-label="刷新">
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
      {!items && !error && <div className="px-3 text-sm text-zinc-500">读取中…</div>}
      {items && !shown.length && <div className="px-3 text-sm text-zinc-500">没有找到会话</div>}
      <div className="px-1">
        {groups.map((g) => (
          <ProjectGroup
            key={g.project}
            scope="history"
            project={g.project}
            name={g.name}
            count={g.items.length}
            actions={inWorkspace(g.project) && <QuickNew project={g.project} agents={agents} onCreated={onOpen} />}
          >
            {g.items.map((s) => {
              const key = `${s.agent}:${s.id}`;
              return (
                <button
                  key={key}
                  onClick={() => open(s)}
                  disabled={opening !== null}
                  className="mb-0.5 block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-zinc-800/60 disabled:opacity-60"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{s.title}</span>
                    {opening === key ? <Icon name="refresh" className="animate-spin text-zinc-400" /> : <AgentBadge agent={s.agent} />}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {s.subdir}
                    </span>
                    {!inWorkspace(s.cwd) && (
                      <span className="shrink-0 text-amber-500/80" title="不在工作区内，只能查看历史">
                        只读
                      </span>
                    )}
                    {s.importedAs ? <span className="shrink-0 text-emerald-500">已打开</span> : <span className="shrink-0">{s.source}</span>}
                    <span className="shrink-0">{relDay(s.updatedAt)}</span>
                  </div>
                </button>
              );
            })}
          </ProjectGroup>
        ))}
      </div>
    </div>
  );
}
