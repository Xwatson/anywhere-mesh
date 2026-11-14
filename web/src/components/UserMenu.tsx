import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentUsage, SystemInfo, UsageInfo, UsageWindow } from '../../../server/src/shared/protocol';
import { api, type User } from '../lib/api';
import { disablePush, enablePush, pushState, testPush, type PushState } from '../lib/push';
import { AccountsDialog, MemoryDialog, PasswordDialog } from './AccountDialogs';
import { cx, Icon } from './ui';

// The indicator refreshes rarely; opening the menu fetches fresh numbers (server caches 60s).
const BACKGROUND_REFRESH_MS = 10 * 60 * 1000;

const barColor = (p: number) => (p >= 90 ? 'bg-red-500' : p >= 70 ? 'bg-amber-400' : 'bg-emerald-500');

function Bar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div className={cx('h-1.5 overflow-hidden rounded-full bg-zinc-800', className)}>
      <div className={cx('h-full rounded-full', barColor(pct))} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
    </div>
  );
}

function resetText(w: UsageWindow) {
  if (w.resetsAt) {
    const d = new Date(w.resetsAt);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return w.resetsText?.replace(/\s*\([^)]*\)\s*$/, '') ?? '';
}

const maxPct = (u?: AgentUsage) => (u?.ok && u.windows.length ? Math.max(...u.windows.map((w) => w.usedPercent)) : null);

function AgentSection({ name, tone, u }: { name: string; tone: string; u?: AgentUsage }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={cx('text-sm font-medium', tone)}>{name}</span>
        {u?.plan && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300">{u.plan}</span>}
      </div>
      {!u && <div className="text-xs text-zinc-500">读取中…</div>}
      {u && !u.ok && <div className="text-xs text-red-400">{u.error}</div>}
      {u?.ok && !u.windows.length && <div className="text-xs text-zinc-500">没有限额信息</div>}
      {u?.windows.map((w) => (
        <div key={w.label} className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-zinc-300">{w.label}</span>
            <span className="tabular-nums text-zinc-400">
              {Math.round(w.usedPercent)}%{resetText(w) && <span className="text-zinc-600"> · {resetText(w)} 重置</span>}
            </span>
          </div>
          <Bar pct={w.usedPercent} />
        </div>
      ))}
      {u?.notes?.map((n) => (
        <div key={n} className="text-xs text-zinc-500">
          {n}
        </div>
      ))}
    </section>
  );
}

const PUSH_HINTS: Record<PushState, string> = {
  on: '任务完成或需要你确认时，这台设备会收到通知（页面关掉也会）',
  off: '开启后，任务完成或需要你确认时通知这台设备，关掉页面也能收到',
  denied: '浏览器已禁止本站的通知，请在浏览器的网站设置里允许通知后再开启',
  'needs-install': 'iPhone / iPad 需要先在 Safari 里点「分享 → 添加到主屏幕」，从主屏幕打开后才能开启推送',
  insecure: '推送需要通过 HTTPS 访问（例如经 Cloudflare 隧道的域名）',
  unsupported: '当前浏览器不支持推送通知',
};

/** Turns Web Push on or off for the device in hand. */
function PushSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ error?: boolean; text: string } | null>(null);

  useEffect(() => {
    pushState().then(setState, () => setState('unsupported'));
  }, []);

  const run = (fn: () => Promise<void>, done?: string) => async () => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (done) setMsg({ text: done });
    } catch (e) {
      setMsg({ error: true, text: (e as Error).message });
    } finally {
      setBusy(false);
      setState(await pushState().catch(() => 'unsupported' as const));
    }
  };

  const btn = 'rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50';
  return (
    <section className="space-y-1.5 border-t border-zinc-800 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">推送通知</span>
        {state === 'on' && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-300">已开启</span>}
        <span className="ml-auto flex gap-1.5">
          {state === 'off' && (
            <button className={btn} disabled={busy} onClick={run(enablePush, '已开启，可以点「测试」看看效果')}>
              开启
            </button>
          )}
          {state === 'on' && (
            <>
              <button className={btn} disabled={busy} onClick={run(testPush, '测试通知已发出，几秒内应该会收到')}>
                测试
              </button>
              <button className={btn} disabled={busy} onClick={run(disablePush)}>
                关闭
              </button>
            </>
          )}
        </span>
      </div>
      {state && <div className="text-xs text-zinc-500">{PUSH_HINTS[state]}</div>}
      {msg && <div className={cx('text-xs', msg.error ? 'text-red-400' : 'text-emerald-400')}>{msg.text}</div>}
    </section>
  );
}

function uptime(since: number) {
  const m = Math.floor((Date.now() - since) / 60_000);
  if (m < 1) return '刚刚启动';
  if (m < 60) return `已运行 ${m} 分钟`;
  const h = Math.floor(m / 60);
  return h < 24 ? `已运行 ${h} 小时 ${m % 60} 分` : `已运行 ${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

/** Restarts the service (systemd) and reloads the page once it is back. */
function ServiceSection() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'failed'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    api.system().then(setInfo, () => {});
  }, []);

  const restart = async () => {
    setError('');
    let cur: SystemInfo;
    try {
      cur = await api.system();
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const running = cur.running ?? [];
    const warn = [
      running.length
        ? `这些会话正在运行，重启会中断它们（之后发消息可以接着做）：\n${running.map((r) => `· ${r.mine ? '你' : r.owner}：${r.title}`).join('\n')}`
        : cur.busySessions > 0 && `有 ${cur.busySessions} 个会话正在运行，重启会中断它们（之后可以接着发消息继续）。`,
      cur.unbuiltChanges && '注意：源码有改动还没构建（npm run build），重启后不会包含这些改动。',
    ].filter(Boolean);
    if (!confirm(['重启 Anywhere Coding 服务？大约需要几秒钟，页面会自动刷新。', ...warn].join('\n\n'))) return;
    try {
      await api.restartService();
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setPhase('restarting');
    // The old process goes away, then a new one (with a new start time) answers.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const next = await api.system().catch(() => null);
      if (next && next.startedAt !== cur.startedAt) {
        location.reload();
        return;
      }
    }
    setPhase('failed');
  };

  if (!info) return null;
  return (
    <section className="space-y-1.5 border-t border-zinc-800 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">服务</span>
        <span className="text-xs text-zinc-500">{uptime(info.startedAt)}</span>
        {info.unit && (
          <button
            onClick={restart}
            disabled={phase === 'restarting'}
            className="ml-auto flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
          >
            <Icon name="refresh" className={cx('h-3.5 w-3.5', phase === 'restarting' && 'animate-spin')} />
            {phase === 'restarting' ? '重启中…' : '重启服务'}
          </button>
        )}
      </div>
      {info.running?.length ? (
        <div className="text-xs text-emerald-300">
          正在运行：
          {info.running
            .slice(0, 3)
            .map((r) => `${r.mine ? '你' : r.owner}「${r.title}」`)
            .join('、')}
          {info.running.length > 3 && ` 等 ${info.running.length} 个`}
        </div>
      ) : info.busySessions > 0 ? (
        <div className="text-xs text-emerald-300">有 {info.busySessions} 个会话正在运行</div>
      ) : (
        <div className="text-xs text-zinc-500">现在没有正在运行的会话</div>
      )}
      {info.rebuiltSinceStart && <div className="text-xs text-amber-300">服务端已经重新构建，重启后生效</div>}
      {info.unbuiltChanges && <div className="text-xs text-zinc-500">源码有还没构建的改动</div>}
      {!info.unit && <div className="text-xs text-zinc-500">服务不是由 systemd 管理（例如用 npm start 启动），请在终端里手动重启</div>}
      {phase === 'failed' && (
        <div className="text-xs text-red-400">90 秒内没有等到服务恢复。请在电脑上查看日志：journalctl --user -u {info.unit} -n 50</div>
      )}
      {error && <div className="text-xs text-red-400">{error}</div>}
      {phase === 'restarting' && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-zinc-950/85 text-zinc-200">
          <Icon name="refresh" className="h-6 w-6 animate-spin text-emerald-400" />
          <div>正在重启服务…</div>
          <div className="text-xs text-zinc-500">恢复后页面会自动刷新</div>
        </div>
      )}
    </section>
  );
}

/** Bottom-of-sidebar account button; opens upward with usage limits and logout. */
export function UserMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<'accounts' | 'password' | 'memory' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const openDialog = (d: 'accounts' | 'password' | 'memory') => {
    setOpen(false);
    setDialog(d);
  };

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setUsage(await api.usage(refresh));
    } catch {
      /* keep the previous numbers */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), BACKGROUND_REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    void load();
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, load]);

  const fetchedAt = usage && Math.min(usage.claude.fetchedAt, usage.codex.fetchedAt);
  const claudePct = maxPct(usage?.claude);
  const codexPct = maxPct(usage?.codex);

  return (
    <div ref={ref} className="relative border-t border-zinc-800">
      {open && (
        <div className="absolute inset-x-2 bottom-full mb-2 max-h-[70dvh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
          <div className="flex items-center justify-between px-4 pb-1 pt-3">
            <span className="text-sm font-medium">额度使用情况</span>
            <button
              onClick={() => load(true)}
              disabled={loading}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
            >
              <Icon name="refresh" className={cx('h-3.5 w-3.5', loading && 'animate-spin')} /> 刷新
            </button>
          </div>
          <div className="space-y-4 px-4 py-2">
            <AgentSection name="Claude Code" tone="text-claude" u={usage?.claude} />
            <AgentSection name="Codex" tone="text-codex" u={usage?.codex} />
            {fetchedAt && <div className="text-[11px] text-zinc-600">更新于 {new Date(fetchedAt).toLocaleTimeString()}</div>}
          </div>
          <PushSection />
          {/* The service is shared by every account: only admins restart it. */}
          {user.isAdmin && <ServiceSection />}
          <div className="border-t border-zinc-800 p-1">
            {user.isAdmin && (
              <button
                onClick={() => openDialog('accounts')}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                <Icon name="users" /> 账号管理
              </button>
            )}
            {/* Members' AI memory lives in their folder; admins' Claude uses this machine's ~/.claude/CLAUDE.md. */}
            {!user.isAdmin && (
              <button
                onClick={() => openDialog('memory')}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                <Icon name="book" /> 我的记忆
              </button>
            )}
            <button
              onClick={() => openDialog('password')}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              <Icon name="key" /> 修改密码
            </button>
            <button
              // A signed-out device should stop receiving notifications.
              onClick={() => void disablePush().catch(() => {}).finally(onLogout)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              <Icon name="logout" /> 退出登录
            </button>
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-left hover:bg-zinc-800/50"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-700 text-xs font-medium uppercase">
          {user.username.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm">
            <span className="truncate">{user.username}</span>
            {user.isAdmin && <span className="shrink-0 rounded bg-amber-400/15 px-1 text-[10px] leading-4 text-amber-300">管理员</span>}
          </span>
          <span className="flex items-center gap-2 text-[11px] tabular-nums text-zinc-500">
            <span>
              <span className="text-claude">Claude</span> {claudePct === null ? '–' : `${Math.round(claudePct)}%`}
            </span>
            <span>
              <span className="text-codex">Codex</span> {codexPct === null ? '–' : `${Math.round(codexPct)}%`}
            </span>
          </span>
        </span>
        <Icon name="chevron" className={cx('text-zinc-500 transition-transform', open ? 'rotate-90' : '-rotate-90')} />
      </button>
      {/* Portalled: the sidebar drawer is translated, which would trap a fixed overlay inside it. */}
      {dialog &&
        createPortal(
          dialog === 'accounts' ? (
            <AccountsDialog me={user} onClose={() => setDialog(null)} />
          ) : dialog === 'memory' ? (
            <MemoryDialog onClose={() => setDialog(null)} />
          ) : (
            <PasswordDialog onClose={() => setDialog(null)} />
          ),
          document.body,
        )}
    </div>
  );
}
