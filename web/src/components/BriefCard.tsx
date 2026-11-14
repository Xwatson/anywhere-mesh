import { useState } from 'react';
import type { AgentEvent, SessionInfo } from '../../../server/src/shared/protocol';
import { api } from '../lib/api';
import { useSessions } from '../lib/store';
import { Markdown } from './EventViews';
import { HandoffDialog } from './HandoffDialog';
import { Button, Icon } from './ui';

export type BriefRef = Extract<AgentEvent, { type: 'brief' }>;

/**
 * A brief (需求书) the advisor wrote: hand it to a new coding session in its own worktree,
 * or open the session it already went to. `content` is fetched on demand when not given.
 */
export function BriefCard({
  session,
  brief,
  content,
  readOnly,
}: {
  session: SessionInfo;
  brief: BriefRef;
  content?: string;
  /** Another account's advisor, watched by an admin: just the brief's name. */
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(content);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState('');
  const sessions = useSessions();
  // The session it went to may have been deleted since: then it can be handed off again.
  const target = brief.sessionId ? sessions.find((s) => s.id === brief.sessionId) : undefined;
  const handed = brief.status === 'handed_off' && !!target;
  const orphaned = brief.status === 'handed_off' && !target;

  const toggle = async () => {
    if (!open && text === undefined) {
      try {
        const list = await api.briefs(session.id);
        setText(list.find((b) => b.file === brief.file)?.content ?? '（文件已不存在）');
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    setOpen(!open);
  };

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 text-sm">
      <div className="flex items-start gap-2 px-3 py-2">
        <Icon name="book" className="mt-0.5 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">需求书：{brief.title}</div>
          <div className="truncate font-mono text-xs text-zinc-500">
            {brief.file}
            {handed && (brief.branch ? ` · 已交接 → ${brief.branch}` : ' · 已交接')}
            {orphaned && ' · 之前交接的会话已删除'}
            {!handed && brief.ready && <span className="ml-1 rounded bg-emerald-500/15 px-1 text-emerald-300">可开工</span>}
          </div>
        </div>
      </div>
      {open && (
        <div className="max-h-[50dvh] overflow-y-auto border-t border-zinc-800 px-3 py-2">
          <Markdown text={text ?? ''} />
        </div>
      )}
      {error && <div className="px-3 pb-2 text-xs text-red-400">{error}</div>}
      {!readOnly && (
        <div className="flex flex-wrap gap-2 border-t border-zinc-800 px-3 py-2">
          {handed ? (
            <Button variant="secondary" onClick={() => (location.hash = `#/s/${brief.sessionId}`)}>
              <Icon name="branch" /> 打开编码会话
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setDialog(true)}>
              <Icon name="send" /> {orphaned ? '重新交给编码会话' : '交给编码会话'}
            </Button>
          )}
          <Button variant="ghost" onClick={toggle}>
            {open ? '收起' : '查看'}
          </Button>
        </div>
      )}
      {dialog && <HandoffDialog session={session} brief={brief} onClose={() => setDialog(false)} />}
    </div>
  );
}
