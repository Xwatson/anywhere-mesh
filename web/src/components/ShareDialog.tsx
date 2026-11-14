import { useEffect, useState, type FormEvent } from 'react';
import type { SessionInfo, ShareInfo } from '../../../server/src/shared/protocol';
import { api, ApiError, shareLink } from '../lib/api';
import { Button, CopyButton, cx, ErrorText, Icon, Modal } from './ui';

const DURATIONS = [
  { hours: 1, label: '1 小时' },
  { hours: 6, label: '6 小时' },
  { hours: 24, label: '1 天' },
  { hours: 72, label: '3 天' },
  { hours: 168, label: '7 天' },
];
const DEFAULT_HOURS = 24;
const MIN_PASSWORD = 4;

export const fmtAt = (ts: number) => new Date(ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function remaining(ts: number) {
  const ms = ts - Date.now();
  if (ms <= 0) return '已过期';
  const hours = Math.floor(ms / 3600_000);
  if (hours < 1) return `还剩 ${Math.max(1, Math.round(ms / 60_000))} 分钟`;
  if (hours < 24) return `还剩 ${hours} 小时`;
  return `还剩 ${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`;
}

/** A password easy to read out or type on a phone: 6 characters without look-alikes (0/o, 1/l/i). */
function randomCode(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => chars[b % chars.length]).join('');
}

const field = 'rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500';

/**
 * Read-only links to the session for people without an account: optional password,
 * valid for a chosen time (1 day unless changed, 7 days at most), revocable.
 */
export function ShareDialog({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  const [hours, setHours] = useState(DEFAULT_HOURS);
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Passwords of the links made while the dialog is open: the server keeps only a hash, so they are shown now or never.
  const [made, setMade] = useState<Record<string, string>>({});

  useEffect(() => {
    api.shares(session.id).then(setShares, (e: Error) => (setShares([]), setError(e.message)));
  }, [session.id]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const pw = withPassword ? password.trim() : '';
    if (withPassword && pw.length < MIN_PASSWORD) return setError(`密码至少 ${MIN_PASSWORD} 位；不需要密码就取消勾选`);
    setBusy(true);
    setError('');
    try {
      const s = await api.createShare(session.id, { hours, password: pw || undefined, live });
      setShares((cur) => [s, ...(cur ?? [])]);
      setMade((m) => ({ ...m, [s.id]: pw }));
      setPassword('');
      setWithPassword(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (s: ShareInfo) => {
    if (!confirm('取消这个分享？拿到链接的人将不能再打开它。')) return;
    try {
      await api.deleteShare(session.id, s.id);
    } catch (err) {
      // Already gone (expired meanwhile): just drop it from the list.
      if (!(err instanceof ApiError && err.status === 404)) return setError((err as Error).message);
    }
    setShares((cur) => cur?.filter((x) => x.id !== s.id) ?? null);
  };

  /** What to send: the link, and the password when it was just set. */
  const message = (s: ShareInfo) => {
    const pw = made[s.id];
    return pw
      ? `「${session.title}」的会话记录\n链接：${shareLink(s.id)}\n密码：${pw}\n${fmtAt(s.expiresAt)} 前有效`
      : shareLink(s.id);
  };

  return (
    <Modal title="分享会话" onClose={onClose}>
      <div className="space-y-4 p-4">
        <p className="text-sm text-zinc-400">
          生成一个只读链接：拿到链接的人不用登录就能看这个会话的对话记录，不能发消息，也不能做任何操作。到期自动失效，也可以随时取消。
        </p>

        {shares === null ? (
          <div className="text-sm text-zinc-500">读取中…</div>
        ) : (
          shares.length > 0 && (
            <section className="space-y-2">
              <div className="text-xs text-zinc-500">已分享的链接</div>
              {shares.map((s) => (
                <div key={s.id} className={cx('space-y-2 rounded-lg border px-3 py-2', made[s.id] !== undefined ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-950')}>
                  <div className="flex items-center gap-2">
                    <a href={shareLink(s.id)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs text-sky-300 hover:underline">
                      {shareLink(s.id)}
                    </a>
                    <CopyButton text={() => message(s)} label />
                  </div>
                  {made[s.id] && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-zinc-400">密码</span>
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-100">{made[s.id]}</span>
                      <span className="text-zinc-500">只显示这一次，「复制」会连同链接一起复制</span>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                    <span className={cx('inline-flex items-center gap-1', s.hasPassword ? 'text-amber-300/90' : 'text-zinc-400')}>
                      <Icon name="lock" className="h-3 w-3" />
                      {s.hasPassword ? '有密码' : '无密码'}
                    </span>
                    <span>·</span>
                    <span title={s.live ? '对方刷新就能看到之后的新消息' : `只能看到 ${fmtAt(s.createdAt)} 之前的内容`}>
                      {s.live ? '包括之后的新消息' : `截至 ${fmtAt(s.createdAt)}`}
                    </span>
                    <span>·</span>
                    <span>
                      {fmtAt(s.expiresAt)} 过期（{remaining(s.expiresAt)}）
                    </span>
                    <button onClick={() => revoke(s)} className="ml-auto rounded px-1.5 py-0.5 text-red-300 hover:bg-red-500/10">
                      取消分享
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )
        )}

        <form onSubmit={create} className="space-y-3 rounded-lg border border-zinc-800 p-3">
          <div className="text-sm font-medium">{shares?.length ? '再生成一个链接' : '生成链接'}</div>

          <div className="space-y-1.5">
            <div className="text-xs text-zinc-400">有效期</div>
            <div className="flex flex-wrap gap-1.5">
              {DURATIONS.map((d) => (
                <button
                  key={d.hours}
                  type="button"
                  onClick={() => setHours(d.hours)}
                  className={cx(
                    'rounded-lg border px-2.5 py-1 text-sm',
                    hours === d.hours ? 'border-emerald-500 bg-emerald-500/15 text-emerald-200' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500',
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={withPassword}
                onChange={(e) => {
                  setWithPassword(e.target.checked);
                  if (e.target.checked && !password) setPassword(randomCode());
                }}
                className="accent-emerald-500"
              />
              需要密码才能查看
            </label>
            {withPassword && (
              <div className="flex gap-2">
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={`至少 ${MIN_PASSWORD} 位`}
                  maxLength={64}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className={cx(field, 'min-w-0 flex-1 font-mono')}
                />
                <Button type="button" className="shrink-0" onClick={() => setPassword(randomCode())}>
                  换一个
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="text-xs text-zinc-400">对方能看到</div>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="live" checked={live} onChange={() => setLive(true)} className="mt-1 accent-emerald-500" />
              <span>
                全部，包括之后的新消息<span className="block text-xs text-zinc-500">对方刷新或停留在页面上，就能跟着看到最新进展</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="live" checked={!live} onChange={() => setLive(false)} className="mt-1 accent-emerald-500" />
              <span>
                只到现在为止<span className="block text-xs text-zinc-500">之后的对话不会出现在这个链接里</span>
              </span>
            </label>
          </div>

          <ErrorText>{error}</ErrorText>
          <Button variant="primary" type="submit" disabled={busy} className="w-full">
            <Icon name="share" /> {busy ? '生成中…' : '生成链接'}
          </Button>
        </form>
      </div>
    </Modal>
  );
}
