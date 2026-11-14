import { useEffect, useState } from 'react';
import type { AdvisorSettings, SessionInfo } from '../../../server/src/shared/protocol';
import { api } from '../lib/api';
import { cx, ErrorText } from './ui';

const input = 'w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-emerald-500';

/** The advisor's automation: hand briefs off by itself (within limits) and patrol on a schedule. */
export function AutomationSettings({ session }: { session: SessionInfo }) {
  const [s, setS] = useState<AdvisorSettings | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.advisorSettings(session.id).then(setS, (e) => setError((e as Error).message));
  }, [session.id]);

  const save = async (patch: Partial<AdvisorSettings>) => {
    if (!s) return;
    setS({ ...s, ...patch });
    setSaving(true);
    setError('');
    try {
      setS(await api.updateAdvisorSettings(session.id, patch));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const num = (key: keyof AdvisorSettings, lo: number, hi: number) =>
    s && (
      <input
        type="number"
        min={lo}
        max={hi}
        className={input}
        value={s[key] as number}
        onChange={(e) => setS({ ...s, [key]: Number(e.target.value) })}
        onBlur={(e) => void save({ [key]: Number(e.target.value) })}
      />
    );

  if (!s) return <div className="text-sm text-zinc-500">{error || '读取中…'}</div>;
  return (
    <div className="space-y-4 text-sm">
      <section className={cx('space-y-2 rounded-lg border px-3 py-2', s.autoHandoff ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-zinc-800')}>
        <label className="flex cursor-pointer items-start gap-2.5">
          <input type="checkbox" className="mt-1 accent-emerald-500" checked={s.autoHandoff} onChange={(e) => void save({ autoHandoff: e.target.checked })} />
          <span>
            <span className="font-medium">自动交接</span>
            <span className="block text-xs text-zinc-500">管家标了「状态：可开工」的需求书，它一写完就自动开编码会话（独立 worktree，预设模型）。做完自动汇报、管家 回复自动转回；合并仍由你点。</span>
          </span>
        </label>
        <div className="grid grid-cols-1 gap-2 pl-6 sm:grid-cols-3">
          <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">同时最多 {num('maxConcurrent', 1, 5)}</label>
          <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">每天最多 {num('dailyLimit', 1, 20)}</label>
          <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">额度 ≥ % 暂停 {num('quotaStopPercent', 10, 100)}</label>
        </div>
      </section>

      <section className={cx('space-y-2 rounded-lg border px-3 py-2', s.autoMerge ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-zinc-800')}>
        <label className="flex cursor-pointer items-start gap-2.5">
          <input type="checkbox" className="mt-1 accent-emerald-500" checked={s.autoMerge} onChange={(e) => void save({ autoMerge: e.target.checked })} />
          <span>
            <span className="font-medium">自动合并</span>
            <span className="block text-xs text-zinc-500">管家验收说「可以合并」时，分支干净、能顺利合并就直接合并进基础分支并通知你；合并失败（冲突、有未提交改动）会推送让你手动处理。关着的话只提醒你去合并。</span>
          </span>
        </label>
      </section>

      <section className={cx('space-y-2 rounded-lg border px-3 py-2', s.cleanupAfterMerge ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-zinc-800')}>
        <label className="flex cursor-pointer items-start gap-2.5">
          <input type="checkbox" className="mt-1 accent-emerald-500" checked={s.cleanupAfterMerge} onChange={(e) => void save({ cleanupAfterMerge: e.target.checked })} />
          <span>
            <span className="font-medium">合并后清理</span>
            <span className="block text-xs text-zinc-500">合并进基础分支后自动删掉 worktree 目录和分支，会话保留为历史。</span>
          </span>
        </label>
      </section>

      <section className={cx('space-y-2 rounded-lg border px-3 py-2', s.patrol ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-zinc-800')}>
        <label className="flex cursor-pointer items-start gap-2.5">
          <input type="checkbox" className="mt-1 accent-emerald-500" checked={s.patrol} onChange={(e) => void save({ patrol: e.target.checked })} />
          <span>
            <span className="font-medium">定时巡视</span>
            <span className="block text-xs text-zinc-500">管家定期自己看项目变化、查竞品与开源动向、整理待办，然后给你一段摘要（会推送）。打开后 10 分钟内先跑一次。额度刹车同上。</span>
          </span>
        </label>
        <label className="flex items-center gap-2 pl-6 text-xs text-zinc-400">每 {num('patrolHours', 1, 720)} 小时一次（168 = 每周）</label>
      </section>

      <ErrorText>{error}</ErrorText>
      <div className="text-xs text-zinc-600">{saving ? '保存中…' : '改动即时保存，存在这个项目的记忆目录里（settings.json）'}</div>
    </div>
  );
}
