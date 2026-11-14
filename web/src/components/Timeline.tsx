import type { ReactNode } from 'react';
import type { AgentEvent, Attachment, StoredEvent, TodoEntry } from '../../../server/src/shared/protocol';
import { MessageAttachments } from './Attachments';
import { cx } from './ui';

// The conversation as both the session page and a shared link show it.

export type Ev<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;

export type Item =
  | { kind: 'user'; key: string; text: string; attachments?: Attachment[] }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; ev: Ev<'tool_call'> }
  | { kind: 'perm'; key: string; ev: Ev<'permission_request'>; resolved?: Ev<'permission_resolved'> }
  | { kind: 'turn'; key: string; ev: Ev<'turn_end'>; retryText?: string }
  | { kind: 'notice'; key: string; ev: Ev<'notice'> }
  | { kind: 'brief'; key: string; ev: Ev<'brief'> };

/** Folds the event log into render items; tool updates replace their earlier entry. */
export function buildItems(events: StoredEvent[]) {
  const items: Item[] = [];
  const index = new Map<string, number>();
  let todos: TodoEntry[] = [];
  let model: string | undefined;
  let context = null as { used: number; window?: number } | null;
  let lastUser: string | undefined;
  for (const { seq, event: e } of events) {
    const key = String(seq);
    switch (e.type) {
      case 'user_message':
        lastUser = e.text;
        items.push({ kind: 'user', key, text: e.text, attachments: e.attachments });
        break;
      case 'assistant_text':
        items.push({ kind: 'text', key, text: e.text });
        break;
      case 'thinking':
        items.push({ kind: 'thinking', key, text: e.text });
        break;
      case 'tool_call': {
        const at = index.get(`tool:${e.id}`);
        if (at !== undefined) items[at] = { ...(items[at] as Item & { kind: 'tool' }), ev: e };
        else {
          index.set(`tool:${e.id}`, items.length);
          items.push({ kind: 'tool', key, ev: e });
        }
        break;
      }
      case 'permission_request':
        index.set(`perm:${e.id}`, items.length);
        items.push({ kind: 'perm', key, ev: e });
        break;
      case 'permission_resolved': {
        const at = index.get(`perm:${e.id}`);
        if (at !== undefined) items[at] = { ...(items[at] as Item & { kind: 'perm' }), resolved: e };
        break;
      }
      case 'todo':
        todos = e.items;
        break;
      case 'session_info':
        model = e.model ?? model;
        break;
      case 'context':
        context = { used: e.used, window: e.window ?? context?.window };
        break;
      case 'turn_end':
        items.push({ kind: 'turn', key, ev: e, retryText: lastUser });
        break;
      case 'notice':
        items.push({ kind: 'notice', key, ev: e });
        break;
      case 'brief': {
        // One card per brief file; later events (hand-off) update it in place.
        const at = index.get(`brief:${e.file}`);
        if (at !== undefined) items[at] = { ...(items[at] as Item & { kind: 'brief' }), ev: e };
        else {
          index.set(`brief:${e.file}`, items.length);
          items.push({ kind: 'brief', key, ev: e });
        }
        break;
      }
    }
  }
  return { items, todos, model, context };
}


export function fmtDuration(ms?: number) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

export function fmtTokens(n?: number) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** A message the user sent, with its attachments; `urlOf` gives an attachment's address. */
export function UserBubble({ text, attachments, urlOf }: { text: string; attachments?: Attachment[]; urlOf: (id: string) => string }) {
  return (
    <div className="flex flex-col items-end">
      {text.trim() && (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-emerald-600/20 px-3.5 py-2 text-[15px]">{text}</div>
      )}
      {attachments?.length ? <MessageAttachments items={attachments} urlOf={urlOf} /> : null}
    </div>
  );
}

export function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="text-sm text-zinc-500">
      <summary className="cursor-pointer select-none">思考过程</summary>
      <div className="mt-1 whitespace-pre-wrap border-l-2 border-zinc-800 pl-3">{text}</div>
    </details>
  );
}

/** An answered permission request or question. */
export function PermResolvedLine({ ev, resolved }: { ev: Ev<'permission_request'>; resolved: Ev<'permission_resolved'> }) {
  return (
    <div className={cx('text-xs', resolved.allow ? 'text-emerald-500' : 'text-red-400')}>
      {resolved.allow ? '✓ 已允许' : '✕ 已拒绝'} {ev.questions ? '提问' : ev.toolName}
      {resolved.note && ` · ${resolved.note}`}
    </div>
  );
}

/** The line closing a turn: outcome, time, tokens, cost; `children` go after them (e.g. a retry button). */
export function TurnLine({ ev, children }: { ev: Ev<'turn_end'>; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-zinc-600">
      <div className="h-px flex-1 bg-zinc-800" />
      {ev.ok ? '完成' : <span className="text-red-400">{ev.error || '失败'}</span>}
      {ev.durationMs ? ` · ${fmtDuration(ev.durationMs)}` : ''}
      {ev.usage && ` · ↑${fmtTokens(ev.usage.inputTokens)} ↓${fmtTokens(ev.usage.outputTokens)}`}
      {ev.costUsd ? ` · $${ev.costUsd.toFixed(3)}` : ''}
      {children}
      <div className="h-px flex-1 bg-zinc-800" />
    </div>
  );
}

export function NoticeLine({ ev }: { ev: Ev<'notice'> }) {
  return <div className={cx('text-center text-xs', ev.level === 'error' ? 'text-red-400' : 'text-zinc-500')}>{ev.text}</div>;
}
