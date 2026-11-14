import { useState } from 'react';
import type { SessionInfo } from '../../../server/src/shared/protocol';
import { api } from '../lib/api';
import { Button, Icon } from './ui';

/**
 * Shown under a finished turn of a session started from a brief: the reply, editable, to be
 * sent to the product advisor as a message. Sending opens the advisor's chat.
 */
export function ReportCard({ session, advisorId, initial }: { session: SessionInfo; advisorId: string; initial: string }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await api.report(session.id, text.trim());
      location.hash = `#/s/${advisorId}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 text-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon name="compass" className="shrink-0 text-amber-300" />
        <span className="font-medium">转给管家</span>
        <span className="min-w-0 truncate text-xs text-zinc-500">默认是刚才的回复，可以改；管家会据此更新记忆和待办</span>
        <button onClick={() => setHidden(true)} className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" aria-label="收起" title="这次不转">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="px-3 pb-2">
        <textarea
          rows={Math.min(14, Math.max(4, text.split('\n').length + 1))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500 disabled:opacity-60"
        />
      </div>
      {error && <div className="px-3 pb-2 text-xs text-red-400">{error}</div>}
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-3 py-2">
        <Button variant="primary" onClick={send} disabled={busy || !text.trim()}>
          <Icon name="send" /> {busy ? '发送中…' : '发送给管家'}
        </Button>
        {session.brief && <span className="truncate font-mono text-xs text-zinc-500">需求书 {session.brief.file}</span>}
      </div>
    </div>
  );
}
