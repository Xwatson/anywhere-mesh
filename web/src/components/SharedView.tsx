import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { SharedSession, StoredEvent } from '../../../server/src/shared/protocol';
import { api, ApiError, sharedUploadUrl } from '../lib/api';
import { Markdown, PermissionCard, TodoPanel, ToolCard } from './EventViews';
import { fmtAt } from './ShareDialog';
import { buildItems, NoticeLine, PermResolvedLine, ThinkingBlock, TurnLine, UserBubble } from './Timeline';
import { AgentBadge, Button, ErrorText, Icon, RoleBadge, StatusDot } from './ui';

type State = { kind: 'loading' } | { kind: 'ready' } | { kind: 'password' } | { kind: 'gone' } | { kind: 'error'; message: string };

/** Adds events not seen yet, in order. */
function merge(cur: StoredEvent[], more: StoredEvent[]): StoredEvent[] {
  const have = new Set(cur.map((e) => e.seq));
  const add = more.filter((e) => !have.has(e.seq));
  return add.length ? [...cur, ...add].sort((a, b) => a.seq - b.seq) : cur;
}

/** Polling while the agent works, and while it is idle; only when the page is visible. */
const POLL_BUSY_MS = 3_000;
const POLL_IDLE_MS = 15_000;

/** A session someone shared, opened from its link: no login, read-only. */
export function SharedView({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [info, setInfo] = useState<SharedSession | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [firstSeq, setFirstSeq] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const { items, todos } = useMemo(() => buildItems(events), [events]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastSeq = useRef(0);
  lastSeq.current = events.length ? events[events.length - 1].seq : 0;
  const busy = useRef(false);
  busy.current = info?.status !== undefined && info.status !== 'idle';

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.code === 'password') setState({ kind: 'password' });
    else if (e instanceof ApiError && e.status === 404) setState({ kind: 'gone' });
    else setState({ kind: 'error', message: (e as Error).message });
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.shared(token);
      setInfo(r.session);
      setEvents(r.page.events);
      setFirstSeq(r.page.firstSeq);
      setHasMore(r.page.hasMore);
      stick.current = true;
      setState({ kind: 'ready' });
    } catch (e) {
      fail(e);
    }
  }, [token, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.title = info ? `${info.title} · 分享的会话` : '分享的会话 · Anywhere Coding';
  }, [info]);

  const ready = state.kind === 'ready';
  const expiresAt = info?.expiresAt;

  // The link stops working at its expiry time, open or not.
  useEffect(() => {
    if (!ready || !expiresAt) return;
    const ms = expiresAt - Date.now();
    if (ms > 2 ** 31 - 1) return;
    const timer = window.setTimeout(() => setState({ kind: 'gone' }), Math.max(0, ms));
    return () => clearTimeout(timer);
  }, [ready, expiresAt]);

  // Live links: fetch what happened since, often while the agent works.
  const live = !!info?.live;
  useEffect(() => {
    if (!ready || !live) return;
    let stopped = false;
    let inFlight = false;
    let timer: number | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = window.setTimeout(tick, busy.current ? POLL_BUSY_MS : POLL_IDLE_MS);
    };
    const tick = async () => {
      if (stopped || inFlight) return;
      if (document.visibilityState !== 'visible') return schedule();
      inFlight = true;
      try {
        const r = await api.sharedNewer(token, lastSeq.current);
        if (stopped) return;
        if (r.reset) await load();
        else {
          if (r.events.length) setEvents((cur) => merge(cur, r.events));
          setInfo((cur) => (cur && cur.status !== r.status ? { ...cur, status: r.status } : cur));
        }
      } catch (e) {
        // Revoked, expired or password changed: say so. A network hiccup: try again later.
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return fail(e);
      } finally {
        inFlight = false;
      }
      if (!stopped) schedule();
    };
    schedule();
    const onVisible = () => document.visibilityState === 'visible' && void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready, live, token, load, fail]);

  const loadOlder = async () => {
    if (!hasMore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const p = await api.sharedOlder(token, firstSeq);
      setEvents((cur) => merge(cur, p.events));
      setFirstSeq(p.firstSeq);
      setHasMore(p.hasMore);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) fail(e);
    } finally {
      setLoadingOlder(false);
    }
  };

  // Same scrolling as the session page: follow new output at the bottom, keep the place when older history is added above.
  const lastHeight = useRef(0);
  const lastFirstSeq = useRef(firstSeq);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const prepended = firstSeq < lastFirstSeq.current;
    lastFirstSeq.current = firstSeq;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (prepended) el.scrollTop += el.scrollHeight - lastHeight.current;
    lastHeight.current = el.scrollHeight;
  }, [items, firstSeq, ready]);

  const maybeLoadOlder = () => {
    const el = scroller.current;
    if (el && ready && hasMore && !loadingOlder && el.scrollTop < 600) void loadOlder();
  };
  useEffect(maybeLoadOlder, [ready, hasMore, loadingOlder, firstSeq]);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    maybeLoadOlder();
  };

  if (state.kind === 'password') return <PasswordGate token={token} onUnlocked={load} />;
  if (state.kind === 'gone' || state.kind === 'error' || state.kind === 'loading' || !info) {
    return (
      <Centered>
        {state.kind === 'loading' ? (
          <div className="text-sm text-zinc-500">加载中…</div>
        ) : state.kind === 'error' ? (
          <>
            <ErrorText>{state.message}</ErrorText>
            <Button onClick={() => (setState({ kind: 'loading' }), void load())}>重试</Button>
          </>
        ) : (
          <>
            <div className="text-zinc-200">链接不存在或已经过期</div>
            <div className="text-sm text-zinc-500">分享的链接到期、被取消，或者会话已经删除了。可以请分享的人重新生成一个。</div>
          </>
        )}
      </Centered>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {info.live && <StatusDot status={info.status} />}
            <span className="truncate font-medium">{info.title}</span>
            {info.role === 'advisor' && <RoleBadge />}
            <AgentBadge agent={info.agent} />
          </div>
          <div className="truncate text-xs text-zinc-500">
            {info.owner && `${info.owner} 分享 · `}
            {info.project && `项目 ${info.project} · `}
            只读
          </div>
        </div>
        <div className="shrink-0 text-right text-xs text-zinc-500">
          <div>{fmtAt(info.expiresAt)} 过期</div>
          <div className="font-mono text-emerald-400/80">&gt;_ anywhere</div>
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        <div className="mx-auto max-w-3xl space-y-3 px-3 py-4 sm:px-6">
          {hasMore && (
            <div className="flex justify-center">
              <button
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <Icon name={loadingOlder ? 'refresh' : 'up'} className={loadingOlder ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
                {loadingOlder ? '正在加载更早的消息…' : '加载更早的消息'}
              </button>
            </div>
          )}
          {!items.length && <div className="py-16 text-center text-sm text-zinc-500">这个会话还没有内容</div>}
          {items.map((it) => {
            switch (it.kind) {
              case 'user':
                return <UserBubble key={it.key} text={it.text} attachments={it.attachments} urlOf={(file) => sharedUploadUrl(token, file)} />;
              case 'text':
                return <Markdown key={it.key} text={it.text} />;
              case 'thinking':
                return <ThinkingBlock key={it.key} text={it.text} />;
              case 'tool':
                return <ToolCard key={it.key} ev={it.ev} cwd={info.cwd} />;
              case 'perm':
                return it.resolved ? (
                  <PermResolvedLine key={it.key} ev={it.ev} resolved={it.resolved} />
                ) : (
                  <PermissionCard key={it.key} ev={it.ev} cwd={info.cwd} onAnswer={() => {}} waitingFor={info.owner || '会话的主人'} />
                );
              case 'turn':
                return <TurnLine key={it.key} ev={it.ev} />;
              case 'notice':
                return <NoticeLine key={it.key} ev={it.ev} />;
              case 'brief':
                return (
                  <div key={it.key} className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
                    <Icon name="book" className="text-amber-300" />
                    <span className="min-w-0 flex-1 truncate">需求书：{it.ev.title}</span>
                    {it.ev.status === 'handed_off' && <span className="shrink-0 text-xs text-zinc-500">已交给编码会话{it.ev.branch && ` · ${it.ev.branch}`}</span>}
                  </div>
                );
            }
          })}
          {info.status === 'running' && (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> 工作中…
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-zinc-800 bg-zinc-950 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-2">
          {todos.length > 0 && <TodoPanel items={todos} />}
          <div className="text-center text-xs text-zinc-500">
            {info.owner ? `${info.owner} 分享的会话，只能查看` : '分享的会话，只能查看'}
            {' · '}
            {info.live ? '新消息会自动出现' : `内容截至 ${fmtAt(info.createdAt)}`}
          </div>
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-center">
        <div className="font-mono text-emerald-400">&gt;_ anywhere coding</div>
        {children}
      </div>
    </div>
  );
}

function PasswordGate({ token, onUnlocked }: { token: string; onUnlocked: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.unlockShare(token, password);
      await onUnlocked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <div className="space-y-1">
          <div className="font-mono text-emerald-400">&gt;_ anywhere coding</div>
          <p className="flex items-center gap-1.5 text-sm text-zinc-300">
            <Icon name="lock" className="h-3.5 w-3.5 text-amber-300" />
            这个分享的会话需要密码才能查看
          </p>
        </div>
        <input
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 font-mono outline-none focus:border-emerald-500"
        />
        <ErrorText>{error}</ErrorText>
        <Button variant="primary" type="submit" className="w-full py-2.5" disabled={busy || !password.trim()}>
          {busy ? '验证中…' : '查看'}
        </Button>
      </form>
    </div>
  );
}
