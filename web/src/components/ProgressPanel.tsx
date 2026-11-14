import { useCallback, useEffect, useState } from 'react';
import type { AdvisorSettings, Progress, ProgressItem, ProgressStage, SessionInfo } from '../../../server/src/shared/protocol';
import { api } from '../lib/api';
import { HandoffDialog } from './HandoffDialog';
import { Button, cx, ErrorText, Icon, Modal } from './ui';

const STAGES: { stage: ProgressStage; label: string; hint: string; tone: string }[] = [
  { stage: 'waiting_user', label: '等你回答', hint: '编码会话停在一个要你确认或回答的问题上', tone: 'text-amber-300' },
  { stage: 'approved', label: '等你合并', hint: '管家验收过了，合并进基础分支就完成', tone: 'text-emerald-300' },
  { stage: 'orphaned', label: '会话已删除', hint: '活没做完会话就没了：想做就重新交接，不想做就告诉管家撤掉这份需求书', tone: 'text-red-300' },
  { stage: 'working', label: '进行中', hint: '编码会话在做，或在等 管家验收。做完了却没有要合并的改动（比如部署类任务）就点「结束」', tone: 'text-zinc-200' },
  { stage: 'ready', label: '排队待开工', hint: '管家标了可开工；打开自动交接会按顺序自动开工，也可以在「记忆 → 需求书」里手动交', tone: 'text-zinc-300' },
  { stage: 'pending', label: '待议', hint: '管家还没拿定主意，或在等数据 / 甲方', tone: 'text-zinc-400' },
  { stage: 'merged', label: '已合并', hint: '', tone: 'text-zinc-500' },
];

const STATUS: Record<string, string> = { running: '运行中', waiting: '等待确认', idle: '空闲' };

/** Every brief of the project and where it stands; merge or open from here. */
export function ProgressPanel({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
  const [p, setP] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [handoff, setHandoff] = useState<ProgressItem | null>(null);
  const [settings, setSettings] = useState<AdvisorSettings | null>(null);

  const load = useCallback(async () => {
    try {
      setP(await api.progress(session.id));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [session.id]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    api.advisorSettings(session.id).then(setSettings, () => {});
  }, [session.id]);

  const toggle = async (patch: Partial<AdvisorSettings>) => {
    if (!settings) return;
    setSettings({ ...settings, ...patch });
    try {
      setSettings(await api.updateAdvisorSettings(session.id, patch));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const SWITCHES: { key: 'autoHandoff' | 'autoMerge' | 'patrol'; label: string; hint: string }[] = [
    { key: 'autoHandoff', label: '自动交接', hint: '排队的需求书按顺序自动开工' },
    { key: 'autoMerge', label: '自动合并', hint: '管家验收通过就合并' },
    { key: 'patrol', label: '定时巡视', hint: '管家定期自己看项目和竞品' },
  ];

  const merge = async (it: ProgressItem) => {
    if (!it.sessionId || !confirm(`把「${it.title}」的分支 ${it.branch ?? ''} 合并进基础分支？`)) return;
    setWorking(it.file);
    try {
      const r = await api.worktreeAction(it.sessionId, 'merge');
      setDone((d) => ({ ...d, [it.file]: `已合并：${r.summary ?? ''}` }));
    } catch (e) {
      setDone((d) => ({ ...d, [it.file]: `合并失败：${(e as Error).message}` }));
    } finally {
      setWorking(null);
      void load();
    }
  };

  const finish = async (it: ProgressItem) => {
    if (!it.sessionId || !confirm(`结束「${it.title}」？\n它没有要合并的改动，结束后 管家 会把待办关掉，排队的需求书可以开工。`)) return;
    setWorking(it.file);
    try {
      await api.finish(it.sessionId);
      setDone((d) => ({ ...d, [it.file]: '已结束，管家已收到' }));
    } catch (e) {
      setDone((d) => ({ ...d, [it.file]: `结束失败：${(e as Error).message}` }));
    } finally {
      setWorking(null);
      void load();
    }
  };

  const open = (id?: string) => {
    if (!id) return;
    onClose();
    location.hash = `#/s/${id}`;
  };

  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Icon name="compass" /> 进展
        </span>
      }
    >
      <div className="space-y-4 p-4 text-sm">
        <ErrorText>{error}</ErrorText>
        {!p && !error && <div className="text-zinc-500">读取中…</div>}
        {p && (
          <div className={cx('rounded-lg border px-3 py-2', p.attention ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-800 bg-zinc-950/50')}>
            <div className="text-xs text-zinc-500">结论</div>
            <div className="font-medium">{p.summary}</div>
            {!p.attention && p.items.length > 0 && <div className="mt-0.5 text-xs text-zinc-500">没有要你处理的事</div>}
          </div>
        )}
        {settings && (
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-lg border border-zinc-800 px-3 py-2">
            {SWITCHES.map((sw) => (
              <label key={sw.key} className="flex cursor-pointer items-center gap-1.5" title={sw.hint}>
                <input type="checkbox" className="accent-emerald-500" checked={settings[sw.key]} onChange={(e) => void toggle({ [sw.key]: e.target.checked })} />
                <span className={settings[sw.key] ? 'text-emerald-300' : 'text-zinc-300'}>{sw.label}</span>
                <span className="hidden text-xs text-zinc-500 sm:inline">{sw.hint}</span>
              </label>
            ))}
            <span className="ml-auto text-xs text-zinc-600">上限等细节在「记忆 → 自动」</span>
          </div>
        )}
        {p &&
          STAGES.map(({ stage, label, hint, tone }) => {
            const items = p.items.filter((i) => i.stage === stage);
            if (!items.length) return null;
            return (
              <section key={stage} className="space-y-1.5">
                <div className="flex items-baseline gap-2">
                  <span className={cx('font-medium', tone)}>{label}</span>
                  <span className="text-xs text-zinc-600">{items.length}</span>
                  {hint && <span className="truncate text-xs text-zinc-500">{hint}</span>}
                </div>
                {items.map((it) => (
                  <div key={it.file} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{it.title}</div>
                        <div className="truncate font-mono text-xs text-zinc-500">
                          {it.branch ?? it.file}
                          {it.commits !== undefined && ` · ${it.commits} 个提交`}
                          {it.sessionStatus && ` · ${STATUS[it.sessionStatus] ?? it.sessionStatus}`}
                        </div>
                      </div>
                      {stage === 'approved' && (
                        <Button variant="primary" className="shrink-0 px-2.5 py-1" onClick={() => void merge(it)} disabled={working === it.file}>
                          <Icon name="check" /> {working === it.file ? '合并中…' : '合并'}
                        </Button>
                      )}
                      {stage === 'working' && it.sessionStatus === 'idle' && (
                        <Button variant="secondary" className="shrink-0 px-2.5 py-1" onClick={() => void finish(it)} disabled={working === it.file} title="没有要合并的改动时，结束它并释放名额">
                          {working === it.file ? '结束中…' : '结束'}
                        </Button>
                      )}
                      {(stage === 'ready' || stage === 'orphaned') && (
                        <Button variant="primary" className="shrink-0 px-2.5 py-1" onClick={() => setHandoff(it)}>
                          <Icon name="send" /> {stage === 'orphaned' ? '重新交接' : '交给编码会话'}
                        </Button>
                      )}
                      {it.sessionId && stage !== 'orphaned' && (
                        <Button variant="ghost" className="shrink-0 px-2 py-1" onClick={() => open(it.sessionId)} title="打开编码会话">
                          <Icon name="branch" />
                        </Button>
                      )}
                    </div>
                    {done[it.file] && <div className={cx('mt-1 text-xs', /失败/.test(done[it.file]) ? 'text-red-400' : 'text-emerald-400')}>{done[it.file]}</div>}
                  </div>
                ))}
              </section>
            );
          })}
      </div>
      {handoff && (
        <HandoffDialog
          session={session}
          brief={{ type: 'brief', file: handoff.file, title: handoff.title, status: handoff.stage === 'orphaned' ? 'handed_off' : 'new', sessionId: handoff.sessionId, branch: handoff.branch }}
          onClose={() => {
            setHandoff(null);
            void load();
          }}
        />
      )}
    </Modal>
  );
}
