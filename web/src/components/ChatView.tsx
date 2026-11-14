import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { ClaudePermissionMode, CodexApprovalPolicy, CodexSandboxMode, EffortLevel, SessionInfo } from '../../../server/src/shared/protocol';
import { api, ApiError, uploadFile, uploadUrl } from '../lib/api';
import { ComposerAttachments, type PendingFile } from './Attachments';
import { ContextRing, GhostSelect } from './ComposerControls';
import { socket } from '../lib/socket';
import { addSession, loadOlder, requestNotifyPermission, useConnState, useSessions, useTimeline } from '../lib/store';
import { DiffView } from './DiffView';
import { BriefCard } from './BriefCard';
import { MemoryPanel } from './MemoryPanel';
import { ProgressPanel } from './ProgressPanel';
import { ReportCard } from './ReportCard';
import { ShareDialog } from './ShareDialog';
import { buildItems, NoticeLine, PermResolvedLine, ThinkingBlock, TurnLine, UserBubble } from './Timeline';
import { WorktreePanel } from './WorktreePanel';
import { Markdown, PermissionCard, TodoPanel, ToolCard } from './EventViews';
import { EFFORT_LABELS, effortChoices, modelChoices, useModels } from '../lib/models';
import { APPROVAL_POLICIES, PERMISSION_MODES, SANDBOX_MODES } from './NewDialogs';
import { AgentBadge, Button, cx, Icon, RoleBadge, shortPath, StatusDot } from './ui';

/** Phones get the short label, wider screens the full one. */
function Short({ short, full }: { short: string; full?: string }) {
  return (
    <>
      <span className="sm:hidden">{short}</span>
      <span className="hidden sm:inline">{full}</span>
    </>
  );
}

const SANDBOX_SHORT: Record<CodexSandboxMode, string> = {
  'workspace-write': '可写',
  'read-only': '只读',
  'danger-full-access': '完全',
};
const APPROVAL_SHORT: Record<CodexApprovalPolicy, string> = {
  'on-request': '按需审批',
  untrusted: '逐个审批',
  never: '不审批',
};

export function ChatView({
  session,
  onOpenSidebar,
  onOpenTerminal,
  member,
  owner,
  onDeleted,
}: {
  session: SessionInfo;
  onOpenSidebar: () => void;
  /** Unset for accounts that may not open terminals (members). */
  onOpenTerminal?: (cwd: string) => void;
  /** The session belongs to a member account: it works on the member's computer, not here. */
  member?: boolean;
  /** Another account's session, watched by an admin (its account's name): read-only, nothing here acts on it. */
  owner?: string;
  onDeleted: () => void;
}) {
  const tl = useTimeline(session.id);
  const conn = useConnState();
  const { items, todos, model, context } = useMemo(() => buildItems(tl.events), [tl.events]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [showWorktree, setShowWorktree] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [attention, setAttention] = useState(0);
  const [menu, setMenu] = useState(false);
  const [behind, setBehind] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [holders, setHolders] = useState<{ pid: number; entrypoint: string }[]>([]);
  const [syncing, setSyncing] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastSent = useRef('');
  const busy = session.status !== 'idle';
  const watching = owner !== undefined;
  // A member's sessions work on its own computer: in the project folder picked for the session, or its home folder.
  const remotePlace = session.remoteCwd ?? (member ? '主目录' : undefined);
  const place = remotePlace === undefined ? shortPath(session.cwd) : `${watching ? `${owner} 的电脑` : '你的电脑'}：${remotePlace}`;
  /** The project's product advisor: no diff (it never edits the project), a memory panel instead. */
  const advisor = session.role === 'advisor';
  // The advisor a coding session reports to: the one it was handed off from, else the project's current one.
  const all = useSessions();
  const pmId = advisor
    ? undefined
    : session.brief && all.some((s) => s.id === session.brief!.advisorId)
      ? session.brief.advisorId
      : all.filter((s) => s.role === 'advisor' && s.project === session.project).sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
  // Advisor: how many briefs need the user right now, for the 进展 button; refreshed when anything in the project settles.
  useEffect(() => {
    if (!advisor || watching) return;
    let stale = false;
    const load = () => api.progress(session.id).then((p) => !stale && setAttention(p.attention)).catch(() => {});
    load();
    const timer = window.setInterval(() => document.visibilityState === 'visible' && load(), 60_000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [advisor, watching, session.id, all]);
  // Sessions started from a brief report back to the advisor after each turn (legacy ones: by their branch name).
  const reportable = !!session.brief || !!session.worktree?.branch.startsWith('ac/pm-');
  // The assistant's text since the last user message: the default content of a report.
  const lastReply = useMemo(() => {
    const texts: string[] = [];
    for (let i = items.length - 1; i >= 0 && items[i].kind !== 'user'; i--) {
      const it = items[i];
      if (it.kind === 'text') texts.unshift(it.text);
    }
    return texts.join('\n\n');
  }, [items]);

  // Content height after the last render, to keep the view still when older history is prepended.
  const lastHeight = useRef(0);
  const lastFirstSeq = useRef(tl.firstSeq);

  // Follow new output while the user is at the bottom; when older history was added above,
  // shift by its height so what the user is reading stays in place.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const prepended = tl.firstSeq < lastFirstSeq.current;
    lastFirstSeq.current = tl.firstSeq;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (prepended) el.scrollTop += el.scrollHeight - lastHeight.current;
    lastHeight.current = el.scrollHeight;
  }, [items, tl.liveText, tl.liveTool, tl.firstSeq]);

  // Load the previous page when the user nears the top (or the page does not fill the view yet).
  const maybeLoadOlder = () => {
    const el = scroller.current;
    if (el && tl.loaded && tl.hasMore && !tl.loadingOlder && el.scrollTop < 600) void loadOlder(session.id);
  };
  useEffect(maybeLoadOlder, [tl.loaded, tl.hasMore, tl.loadingOlder, tl.firstSeq, session.id]);

  useEffect(() => {
    stick.current = true;
    setText(sessionStorage.getItem(`draft:${session.id}`) ?? '');
  }, [session.id]);

  useEffect(() => {
    try {
      sessionStorage.setItem(`draft:${session.id}`, text);
    } catch {
      /* storage unavailable */
    }
  }, [text, session.id]);

  // Server-side failures for this session (e.g. its directory is outside the workspace).
  useEffect(
    () =>
      socket.on((m) => {
        if (m.t === 'error' && m.sessionId === session.id) {
          setError(m.message);
          // The message was refused, so give the user their text back.
          setText((cur) => cur || lastSent.current);
        }
      }),
    [session.id],
  );

  // Detect when the same session was continued elsewhere (CLI / IDE) since we last saw it,
  // and whether a terminal Claude Code currently has it open.
  useEffect(() => {
    if (!session.agentSessionId || watching) return;
    let stale = false;
    const check = () =>
      api
        .syncStatus(session.id)
        .then((r) => {
          if (stale) return;
          if (session.status === 'idle') setBehind(r.behind);
          setHolders(r.holders ?? []);
        })
        .catch(() => {});
    void check();
    const timer = window.setInterval(() => document.visibilityState === 'visible' && void check(), 30_000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [session.id, session.status, session.agentSessionId, watching]);

  const compact = () => {
    setMenu(false);
    if (!confirm('压缩上下文？\n会把之前的对话总结成摘要以节省 token，细节可能丢失。压缩本身会调用一次模型。')) return;
    if (!socket.send({ t: 'compact', sessionId: session.id })) setError('连接已断开，请稍后重试');
  };

  const resync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await api.resync(session.id);
      setBehind(false);
      stick.current = true;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    maybeLoadOlder();
  };

  const uploading = pending.some((p) => !p.attachment && !p.error);
  const ready = pending.filter((p) => p.attachment);

  const addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = `${Date.now()}-${Math.random()}`;
      const preview = /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : undefined;
      setPending((cur) => [...cur, { key, file, preview, progress: 0 }]);
      const update = (patch: Partial<PendingFile>) =>
        setPending((cur) => cur.map((p) => (p.key === key ? { ...p, ...patch } : p)));
      uploadFile(session.id, file, (progress) => update({ progress })).then(
        (attachment) => update({ attachment, progress: 1 }),
        (e) => update({ error: (e as Error).message }),
      );
    }
  };

  const removePending = (key: string) =>
    setPending((cur) => {
      const gone = cur.find((p) => p.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return cur.filter((p) => p.key !== key);
    });

  // Paste screenshots straight into the input.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const send = () => {
    const t = text.trim();
    if ((!t && !ready.length) || uploading) return;
    requestNotifyPermission();
    if (!socket.send({ t: 'send', sessionId: session.id, text: t, attachments: ready.map((p) => p.attachment!.id) })) {
      setError('连接已断开，正在重连…');
      return;
    }
    lastSent.current = t;
    setError('');
    setText('');
    for (const p of pending) if (p.preview) URL.revokeObjectURL(p.preview);
    setPending([]);
    stick.current = true;
  };

  const lastItem = items[items.length - 1];
  const retry = (t: string) => {
    lastSent.current = t;
    if (!socket.send({ t: 'send', sessionId: session.id, text: t })) setError('连接已断开，正在重连…');
    stick.current = true;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop: Enter sends, Shift+Enter newline. Touch devices: Enter is newline.
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  // Grow the textarea with its content up to a limit.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight excludes the border; with border-box sizing it must be added back,
    // otherwise the box is always 2px short and shows a scrollbar.
    const full = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    el.style.height = `${Math.min(full, 200)}px`;
    el.style.overflowY = full > 200 ? 'auto' : 'hidden';
  }, [text]);

  const answer = (requestId: string) => (a: Parameters<Parameters<typeof PermissionCard>[0]['onAnswer']>[0]) => {
    if (!socket.send({ t: 'perm', sessionId: session.id, requestId, ...a })) setError('连接已断开，请稍后重试');
  };

  const setMode = (mode: ClaudePermissionMode) => socket.send({ t: 'mode', sessionId: session.id, mode });
  const setEffort = (effort: EffortLevel | null) => socket.send({ t: 'effort', sessionId: session.id, effort });
  const models = useModels();
  const effort = effortChoices(models, session.agent, session.options.model);
  const modelList = modelChoices(models, session.agent);

  const rename = async () => {
    setMenu(false);
    const title = prompt('会话标题', session.title);
    if (title?.trim()) await api.updateSession(session.id, { title });
  };

  const remove = async () => {
    setMenu(false);
    const wt = session.worktree?.exists ? session.worktree : null;
    if (!confirm(`删除会话「${session.title}」？聊天记录将被清除${advisor ? '（管家的记忆文件会保留）' : wt ? '' : '（不影响项目文件）'}。`)) return;
    try {
      if (wt && confirm(`同时删除它的 worktree 目录和分支 ${wt.branch} 吗？\n「取消」则保留目录和分支，之后可以手动处理。`)) {
        try {
          await api.deleteSession(session.id, { removeWorktree: true });
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 400) throw e;
          if (!confirm(`${e.message}\n\n强制删除？未提交的改动和未合并的提交会丢失。`)) return;
          await api.deleteSession(session.id, { removeWorktree: true, force: true });
        }
      } else {
        await api.deleteSession(session.id);
      }
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Advisor: a new conversation that starts from the memory files; this one stays as history. */
  const restart = async () => {
    setMenu(false);
    if (!confirm('重新开始对话？\n当前对话保留为历史，新对话会读取 管家的记忆继续。')) return;
    try {
      const s = await api.createSession({ agent: 'claude', cwd: session.cwd, role: 'advisor', fresh: true, options: {} });
      addSession(s);
      location.hash = `#/s/${s.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const sandboxLabel =
    session.agent === 'codex' ? SANDBOX_MODES.find((m) => m.value === session.options.sandboxMode)?.label : undefined;
  // Short labels for the toolbar; "默认（x）" shows just what the default resolves to.
  const unwrapDefault = (label: string) => label.match(/^默认（(.+)）$/)?.[1] ?? label;
  const modelDisplay = session.options.model
    ? (modelList.options.find((m) => m.id === session.options.model)?.name ?? session.options.model)
    : session.agent === 'codex'
      ? unwrapDefault(modelList.defaultLabel)
      : (model ?? '默认模型');
  const effortDisplay = !effort.efforts.length
    ? '推理：不支持'
    : session.options.effort
      ? (EFFORT_LABELS[session.options.effort] ?? session.options.effort)
      : unwrapDefault(effort.defaultLabel) === '默认'
        ? '默认推理'
        : unwrapDefault(effort.defaultLabel);

  return (
    <div
      className="relative flex h-full min-w-0 flex-col"
      onDragOver={(e) => {
        if (watching || !session.inWorkspace || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (watching || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-emerald-500 bg-zinc-950/80 text-emerald-300">
          松开即可添加附件
        </div>
      )}
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button onClick={onOpenSidebar} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 md:hidden" aria-label="菜单">
          <Icon name="menu" className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot status={session.status} />
            <span className="truncate font-medium">{session.title}</span>
            {session.agentSessionId && !watching && (
              <button
                onClick={resync}
                disabled={syncing || busy}
                className={cx(
                  'relative shrink-0 rounded p-1 transition-colors disabled:cursor-not-allowed',
                  behind ? 'text-amber-400 hover:bg-amber-500/10' : 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-400',
                  busy && !syncing && 'opacity-50',
                )}
                title={
                  syncing
                    ? '正在同步…'
                    : busy
                      ? '运行中，结束后才能同步'
                      : behind
                        ? '这个会话在 CLI 或其他地方有更新的内容，点击同步'
                        : '已是最新。点击可从本机记录重新同步'
                }
                aria-label={behind ? '有更新，点击同步' : '从本机记录重新同步'}
              >
                <Icon name="refresh" className={cx('h-3.5 w-3.5', syncing && 'animate-spin')} />
                {behind && !syncing && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />}
              </button>
            )}
            {advisor && <RoleBadge />}
            <span className="hidden sm:inline">
              <AgentBadge agent={session.agent} />
            </span>
            {watching && (
              <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300" title={`${owner} 的会话：你只能查看`}>
                {owner} · 只读
              </span>
            )}
            {session.worktree && (
              <button
                onClick={() => setShowWorktree(true)}
                className={cx(
                  'flex min-w-0 shrink items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] hover:bg-zinc-700',
                  session.worktree.exists ? 'text-emerald-300/90' : 'text-zinc-500 line-through',
                )}
                title={`worktree：分支 ${session.worktree.branch}，基于 ${session.worktree.base}`}
              >
                <Icon name="branch" className="h-3 w-3" />
                <span className="truncate">{session.worktree.branch}</span>
              </button>
            )}
          </div>
          <div className="truncate font-mono text-xs text-zinc-500">
            {place}
            {(model || session.options.model) && ` · ${model || session.options.model}`}
          </div>
        </div>

        {/* Watching another account's session: nothing here acts on it. */}
        {!watching && (
          <>
            {advisor && (
              <Button variant="ghost" className="relative px-2" onClick={() => setShowProgress(true)} title="每份需求书走到哪了、哪些等你处理">
                <Icon name="compass" />
                <span>进展</span>
                {attention > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-amber-400 px-1 text-center text-[10px] font-semibold text-amber-950">{attention}</span>
                )}
              </Button>
            )}
            {advisor ? (
              <Button variant="ghost" className="px-2" onClick={() => setShowMemory(true)} title="管家的记忆：项目画像、甲方、竞品与开源、决策日志、提案与待办">
                <Icon name="book" />
                <span className="hidden sm:inline">记忆</span>
              </Button>
            ) : (
              // A member's projects are on its own computer: there is no repository here to show.
              !member && (
                <Button variant="ghost" className="px-2" onClick={() => setShowDiff(true)} title="查看改动">
                  <Icon name="diff" />
                  <span className="hidden sm:inline">改动</span>
                </Button>
              )
            )}
            <div className="relative">
              <Button variant="ghost" className="px-2" onClick={() => setMenu(!menu)} aria-label="更多">
                ⋯
              </Button>
              {menu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm shadow-xl">
                    {onOpenTerminal && (
                      <button onClick={() => (setMenu(false), onOpenTerminal(session.cwd))} className="flex w-full items-center gap-2 px-3 py-2 hover:bg-zinc-800">
                        <Icon name="terminal" /> 在此目录开终端
                      </button>
                    )}
                    {session.agentSessionId && session.inWorkspace && (
                      <button onClick={compact} disabled={busy} className="flex w-full items-center gap-2 px-3 py-2 hover:bg-zinc-800 disabled:opacity-40">
                        <Icon name="diff" /> 压缩上下文
                      </button>
                    )}
                    {session.worktree && (
                      <button onClick={() => (setMenu(false), setShowWorktree(true))} className="flex w-full items-center gap-2 px-3 py-2 hover:bg-zinc-800">
                        <Icon name="branch" /> Worktree：合并 / 删除
                      </button>
                    )}
                    {advisor && (
                      <button
                        onClick={restart}
                        disabled={busy}
                        className="flex w-full items-center gap-2 px-3 py-2 hover:bg-zinc-800 disabled:opacity-40"
                        title="当前对话保留为历史，新对话从记忆文件继续"
                      >
                        <Icon name="refresh" /> 重新开始对话
                      </button>
                    )}
                    <button
                      onClick={() => (setMenu(false), setShowShare(true))}
                      className="flex w-full items-center gap-2 px-3 py-2 hover:bg-zinc-800"
                      title="生成一个只读链接，对方不用登录就能查看这个会话"
                    >
                      <Icon name="share" /> 分享
                    </button>
                    <button onClick={rename} className="flex w-full items-center gap-2 px-3 py-2 hover:bg-zinc-800">
                      <Icon name="edit" /> 重命名
                    </button>
                    <button onClick={remove} className="flex w-full items-center gap-2 px-3 py-2 text-red-300 hover:bg-zinc-800">
                      <Icon name="trash" /> 删除会话
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </header>

      {holders.length > 0 && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          这个会话正在终端 Claude Code 中打开（PID {holders.map((h) => h.pid).join(', ')}）。两边同时使用可能导致请求被拒绝或记录错乱，建议先在终端里输入 /exit 退出。
        </div>
      )}

      {/* overflow-anchor: none — the prepend offset is applied by hand, browsers that also anchor would double it. */}
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        <div className="mx-auto max-w-3xl space-y-3 px-3 py-4 sm:px-6">
          {!tl.loaded && <div className="text-center text-sm text-zinc-500">加载中…</div>}
          {tl.loaded && tl.hasMore && (
            <div className="flex justify-center">
              <button
                onClick={() => void loadOlder(session.id)}
                disabled={tl.loadingOlder}
                className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:hover:bg-transparent"
              >
                {tl.loadingOlder ? (
                  <>
                    <Icon name="refresh" className="h-3 w-3 animate-spin" /> 正在加载更早的消息…
                  </>
                ) : (
                  <>
                    <Icon name="up" className="h-3 w-3" /> 加载更早的消息
                  </>
                )}
              </button>
            </div>
          )}
          {tl.loaded && !items.length && (
            <div className="py-16 text-center text-sm text-zinc-500">
              {watching
                ? `${owner} 还没有在这个会话里发过消息`
                : advisor
                  ? '向管家交代事情，或问它项目的进展'
                  : `向 ${session.agent === 'claude' ? 'Claude Code' : 'Codex'} 描述你要做的事`}
              <div className="mt-1 font-mono text-xs">{place}</div>
            </div>
          )}
          {items.map((it) => {
            switch (it.kind) {
              case 'user':
                return <UserBubble key={it.key} text={it.text} attachments={it.attachments} urlOf={(file) => uploadUrl(session.id, file)} />;
              case 'text':
                return <Markdown key={it.key} text={it.text} />;
              case 'thinking':
                return <ThinkingBlock key={it.key} text={it.text} />;
              case 'tool':
                return <ToolCard key={it.key} ev={it.ev} cwd={session.remoteCwd ?? session.cwd} live={tl.liveTool[it.ev.id]} />;
              case 'perm':
                return it.resolved ? (
                  <PermResolvedLine key={it.key} ev={it.ev} resolved={it.resolved} />
                ) : (
                  <PermissionCard key={it.key} ev={it.ev} cwd={session.remoteCwd ?? session.cwd} onAnswer={answer(it.ev.id)} waitingFor={owner} />
                );
              case 'turn':
                return (
                  <TurnLine key={it.key} ev={it.ev}>
                    {/* Only the latest failed turn offers a retry, and only when the session can run. */}
                    {!it.ev.ok && it.ev.error !== '已中断' && it.retryText && it === lastItem && !busy && session.inWorkspace && !watching && (
                      <button
                        onClick={() => retry(it.retryText!)}
                        className="ml-1 rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-zinc-500"
                      >
                        重试
                      </button>
                    )}
                  </TurnLine>
                );
              case 'notice':
                return <NoticeLine key={it.key} ev={it.ev} />;
              case 'brief':
                return <BriefCard key={it.key} session={session} brief={it.ev} readOnly={watching} />;
            }
          })}
          {/* After a finished turn, hand the summary to the advisor; keyed per turn so the draft resets with each new reply. */}
          {pmId && reportable && !watching && !busy && lastItem?.kind === 'turn' && lastItem.ev.ok && lastReply && (
            <ReportCard key={lastItem.key} session={session} advisorId={pmId} initial={lastReply} />
          )}
          {tl.liveText && (
            <div className="opacity-90">
              <Markdown text={tl.liveText} />
            </div>
          )}
          {session.status === 'running' && !tl.liveText && (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> 工作中…
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-zinc-800 bg-zinc-950 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-2">
          {todos.length > 0 && <TodoPanel items={todos} />}
          {(error || conn !== 'online') && (
            <div className="text-xs text-amber-400">{error || (conn === 'connecting' ? '正在连接…' : '连接已断开，正在重连…')}</div>
          )}
          {watching ? (
            <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
              这是 {owner} 的会话，你只能查看：不能发消息、停止或回答它的确认请求。
            </div>
          ) : session.worktree && !session.worktree.exists ? (
            <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
              这个会话的 worktree（分支 <span className="font-mono">{session.worktree.branch}</span>）已经删除，只能查看历史。
            </div>
          ) : !session.inWorkspace && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              这个会话的目录 <span className="font-mono">{shortPath(session.cwd)}</span>{' '}
              不在工作区内，只能查看历史。如需继续对话，把它（或上级目录）加入 .env 的 WORKSPACE_ROOTS 后重启服务。
            </div>
          )}
          {!watching && (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <div
                className={cx(
                  'rounded-2xl border border-zinc-700 bg-zinc-900 focus-within:border-zinc-500',
                  !session.inWorkspace && 'opacity-50',
                )}
              >
                {pending.length > 0 && (
                  <div className="px-2 pt-2">
                    <ComposerAttachments items={pending} onRemove={removePending} />
                  </div>
                )}
                <div className="flex items-end gap-1.5 py-1.5 pl-3 pr-1.5">
                  <textarea
                    onPaste={onPaste}
                    disabled={!session.inWorkspace}
                    ref={input}
                    rows={1}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKey}
                    placeholder={!session.inWorkspace ? (session.worktree && !session.worktree.exists ? 'worktree 已删除，只能查看历史' : '不在工作区内，只能查看历史') : busy ? '运行中，新消息会排队发送…' : advisor ? '问管家…' : '输入指令…'}
                    className="min-h-[36px] flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-zinc-500 disabled:cursor-not-allowed"
                  />
                  {busy && (
                    <Button
                      variant="danger"
                      className="h-9 w-9 shrink-0 rounded-xl px-0"
                      onClick={() => socket.send({ t: 'interrupt', sessionId: session.id })}
                      aria-label="停止"
                      title="停止"
                    >
                      <Icon name="stop" />
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    className="h-9 w-9 shrink-0 rounded-xl px-0"
                    onClick={send}
                    disabled={(!text.trim() && !ready.length) || uploading || !session.inWorkspace}
                    aria-label="发送"
                  >
                    <Icon name="up" />
                  </Button>
                </div>
              </div>
              {session.inWorkspace && (
                <div className="-mt-1 flex items-center gap-1">
                  <div className="mr-auto flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                      aria-label="添加图片或文件"
                      title="添加图片或文件（也可以直接粘贴截图或拖进来）"
                    >
                      <Icon name="plus" />
                    </button>
                    {session.agent === 'claude' ? (
                      <GhostSelect
                        value={session.options.permissionMode ?? 'default'}
                        onChange={setMode}
                        options={PERMISSION_MODES.map((m) => ({ value: m.value, label: `${m.label} — ${m.hint}` }))}
                        display={PERMISSION_MODES.find((m) => m.value === (session.options.permissionMode ?? 'default'))?.label}
                        title="权限模式"
                        className={session.options.permissionMode === 'bypassPermissions' ? 'text-red-300!' : undefined}
                      />
                    ) : (
                      <>
                        {/* A member's Codex works on the member's computer: nothing here to sandbox differently. */}
                        {!member && (
                          <GhostSelect
                            value={session.options.sandboxMode ?? 'workspace-write'}
                            onChange={(mode: CodexSandboxMode) => socket.send({ t: 'sandbox', sessionId: session.id, mode })}
                            options={SANDBOX_MODES.map((m) => ({ value: m.value, label: `${m.label} — ${m.hint}` }))}
                            display={<Short short={SANDBOX_SHORT[session.options.sandboxMode ?? 'workspace-write']} full={sandboxLabel} />}
                            icon={<Icon name="shield" className="h-3.5 w-3.5" />}
                            title={`沙箱：Codex 能改哪些文件\n${SANDBOX_MODES.map((m) => `${m.label}：${m.hint}`).join('\n')}`}
                            className={session.options.sandboxMode === 'danger-full-access' ? 'text-amber-300/90!' : undefined}
                          />
                        )}
                        <GhostSelect
                          value={session.options.approvalPolicy ?? 'on-request'}
                          onChange={(policy: CodexApprovalPolicy) => socket.send({ t: 'approval', sessionId: session.id, policy })}
                          options={APPROVAL_POLICIES.map((p) => ({ value: p.value, label: `${p.label} — ${p.hint}` }))}
                          display={
                            <Short
                              short={APPROVAL_SHORT[session.options.approvalPolicy ?? 'on-request']}
                              full={APPROVAL_POLICIES.find((p) => p.value === (session.options.approvalPolicy ?? 'on-request'))?.label}
                            />
                          }
                          icon={<Icon name="hand" className="h-3.5 w-3.5" />}
                          title={`审批：Codex 什么时候先问你\n${APPROVAL_POLICIES.map((p) => `${p.label}：${p.hint}`).join('\n')}`}
                        />
                      </>
                    )}
                  </div>
                  <GhostSelect
                    value={session.options.model ?? ''}
                    onChange={(m) => socket.send({ t: 'model', sessionId: session.id, model: m || null })}
                    options={[
                      { value: '', label: modelList.defaultLabel },
                      ...modelList.options.map((m) => ({ value: m.id, label: m.description ? `${m.name} — ${m.description}` : m.name })),
                      ...(session.options.model && !modelList.options.some((m) => m.id === session.options.model)
                        ? [{ value: session.options.model, label: session.options.model }]
                        : []),
                    ]}
                    display={modelDisplay}
                    title="模型"
                    className="shrink! max-w-[10rem]"
                  />
                  <GhostSelect
                    value={session.options.effort ?? ''}
                    disabled={!effort.efforts.length}
                    onChange={(v) => setEffort((v || null) as EffortLevel | null)}
                    options={[
                      { value: '', label: effort.efforts.length ? effort.defaultLabel : '该模型不支持' },
                      ...effort.efforts.map((lvl) => ({ value: lvl, label: EFFORT_LABELS[lvl] ?? lvl })),
                    ]}
                    display={effortDisplay}
                    title="推理强度：越高越慢、越耗额度，但更擅长复杂任务"
                  />
                  <ContextRing context={context} canCompact={!busy && !!session.agentSessionId} onCompact={compact} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showDiff && <DiffView session={session} onClose={() => setShowDiff(false)} />}
      {showMemory && <MemoryPanel session={session} onClose={() => setShowMemory(false)} />}
      {showProgress && <ProgressPanel session={session} onClose={() => setShowProgress(false)} />}
      {showShare && <ShareDialog session={session} onClose={() => setShowShare(false)} />}
      {showWorktree && (
        <WorktreePanel session={session} onClose={() => setShowWorktree(false)} onOpenGit={() => setShowDiff(true)} />
      )}
    </div>
  );
}
