import { useCallback, useEffect, useState } from 'react';
import type { AdvisorMemory, BriefInfo, SessionInfo } from '../../../server/src/shared/protocol';
import { api } from '../lib/api';
import { AutomationSettings } from './AutomationSettings';
import { BriefCard } from './BriefCard';
import { Markdown } from './EventViews';
import { cx, ErrorText, Icon, Modal, shortPath } from './ui';

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString();
}

/** Read-only view of the advisor's memory files plus its briefs; the advisor itself keeps them up to date. */
export function MemoryPanel({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
  const [mem, setMem] = useState<AdvisorMemory | null>(null);
  const [briefs, setBriefs] = useState<BriefInfo[]>([]);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, b] = await Promise.all([api.advisorMemory(session.id), api.briefs(session.id)]);
      setMem(m);
      setBriefs(b);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  // The advisor writes while it works: the files are re-read when its turn ends.
  useEffect(() => {
    if (session.status === 'idle') void load();
  }, [session.status, load]);

  const tabs = mem ? [...mem.files.map((f) => f.label), `需求书${briefs.length ? ` ${briefs.length}` : ''}`, '自动'] : [];
  const briefsTab = mem ? mem.files.length : -1;
  const autoTab = mem ? mem.files.length + 1 : -1;
  const file = mem && active < mem.files.length ? mem.files[active] : null;
  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Icon name="book" /> 管家的记忆
        </span>
      }
    >
      {mem && (
        <div className="sticky top-0 z-10 flex items-center gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
          {tabs.map((label, i) => (
            <button
              key={label}
              onClick={() => setActive(i)}
              className={cx('shrink-0 rounded-md px-2.5 py-1', i === active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => void load()}
            disabled={loading}
            className="ml-auto shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            title="重新读取"
            aria-label="重新读取"
          >
            <Icon name="refresh" className={cx('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      )}
      <div className="px-4 py-3">
        <ErrorText>{error}</ErrorText>
        {!mem && !error && <div className="text-sm text-zinc-500">读取中…</div>}
        {file && (
          <>
            <div className="mb-3 flex flex-wrap gap-x-3 font-mono text-xs text-zinc-500">
              <span className="truncate">
                {shortPath(mem!.dir)}/{file.name}
              </span>
              <span className="shrink-0">更新于 {fmtTime(file.updatedAt)}</span>
            </div>
            <Markdown text={file.content} />
          </>
        )}
        {mem && active === autoTab && <AutomationSettings session={session} />}
        {mem && active === briefsTab && (
          <div className="space-y-3">
            {!briefs.length && (
              <div className="text-sm text-zinc-500">
                还没有需求书。管家 把要落地的改动写成需求书后会出现在这里，也会在对话里出一张卡片，一键交给编码会话。
              </div>
            )}
            {briefs.map((b) => (
              <BriefCard key={b.file} session={session} brief={{ type: 'brief', ...b }} content={b.content} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
