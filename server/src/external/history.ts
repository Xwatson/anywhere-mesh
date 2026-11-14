// Reads sessions that Claude Code and Codex stored locally (from the CLI, IDE
// extensions or this app) and converts their history into our event model.
import { getSessionInfo, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { truncate } from '../agents/types.js';
import type { AgentEvent, AgentKind, ExternalSession, TodoEntry } from '../shared/protocol.js';
import { codexAppServer } from './codexAppServer.js';
import { codexContext } from './codexRollout.js';

const MAX_LIST = 300;
const MAX_EVENTS = 3000;

// ---------------------------------------------------------------- listing

type Listed = Omit<ExternalSession, 'project' | 'subdir'>;

export async function listExternal(agent?: AgentKind): Promise<Listed[]> {
  const jobs: Promise<Listed[]>[] = [];
  if (!agent || agent === 'claude') jobs.push(listClaude());
  if (!agent || agent === 'codex') jobs.push(listCodex());
  const results = await Promise.allSettled(jobs);
  const errors = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason);
  if (errors.length === results.length) throw errors[0];
  return results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function listClaude(): Promise<Listed[]> {
  const sessions = await listSessions({ limit: MAX_LIST });
  return sessions
    .filter((s) => s.cwd)
    // Sessions that only ran a slash command such as /model or /usage are noise.
    .filter((s) => !(s.firstPrompt?.startsWith('/') && (s.fileSize ?? 0) < 20_000))
    .map((s) => ({
      agent: 'claude' as const,
      id: s.sessionId,
      title: oneLine(s.customTitle || s.summary || s.firstPrompt || s.sessionId),
      cwd: s.cwd!,
      createdAt: s.createdAt ?? s.lastModified,
      updatedAt: s.lastModified,
      source: 'cli',
      gitBranch: s.gitBranch,
    }));
}

interface CodexThread {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  source: unknown;
  gitInfo: { branch?: string | null } | null;
  turns: CodexTurn[];
}

async function listCodex(): Promise<Listed[]> {
  const out: Listed[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: CodexThread[]; nextCursor: string | null } = await codexAppServer.call('thread/list', {
      limit: 100,
      cursor,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
    });
    for (const t of page.data) {
      out.push({
        agent: 'codex',
        id: t.id,
        title: oneLine(t.name || t.preview || t.id),
        cwd: t.cwd,
        createdAt: t.createdAt * 1000,
        updatedAt: t.updatedAt * 1000,
        source: typeof t.source === 'string' ? t.source : 'codex',
        gitBranch: t.gitInfo?.branch ?? undefined,
      });
    }
    cursor = page.nextCursor;
  } while (cursor && out.length < MAX_LIST);
  return out;
}

/**
 * How much conversation the agent's own record holds: top-level messages for Claude,
 * turns for Codex. Unlike file times it ignores metadata the CLI appends later
 * (titles, summaries), so it only grows when someone actually continued the session.
 */
export async function externalMark(agent: AgentKind, id: string, cwd: string): Promise<number> {
  if (agent === 'claude') {
    const messages = await getSessionMessages(id, { dir: cwd });
    return messages.filter((m) => !m.parent_tool_use_id && (m.type === 'user' || m.type === 'assistant')).length;
  }
  const r: { thread: CodexThread } = await codexAppServer.call('thread/read', { threadId: id, includeTurns: true });
  return r.thread.turns?.length ?? 0;
}

/** Last-modified time (epoch ms) of the agent's own record of a session. */
export async function externalUpdatedAt(agent: AgentKind, id: string, cwd: string): Promise<number | null> {
  if (agent === 'claude') {
    const info = await getSessionInfo(id, { dir: cwd });
    return info?.lastModified ?? null;
  }
  const r: { thread: CodexThread } = await codexAppServer.call('thread/read', { threadId: id, includeTurns: false });
  return r.thread.updatedAt * 1000;
}

/**
 * The title the agent itself gives a session: Claude's custom or AI-generated title
 * (falling back to the first prompt), Codex's thread name or its first message.
 */
export async function externalTitle(agent: AgentKind, id: string, cwd: string): Promise<string | null> {
  let raw: string | null | undefined;
  if (agent === 'claude') {
    const info = await getSessionInfo(id, { dir: cwd });
    raw = info?.customTitle || info?.summary || info?.firstPrompt;
  } else {
    const r: { thread: CodexThread } = await codexAppServer.call('thread/read', { threadId: id, includeTurns: false });
    raw = r.thread.name || r.thread.preview;
  }
  const title = raw ? oneLine(raw) : '';
  return title && title !== id ? title : null;
}

export async function externalInfo(agent: AgentKind, id: string): Promise<Listed | null> {
  const list = await listExternal(agent);
  return list.find((s) => s.id === id) ?? null;
}

// ---------------------------------------------------------------- history

export async function loadHistory(agent: AgentKind, id: string, cwd: string): Promise<AgentEvent[]> {
  const events = agent === 'claude' ? await claudeHistory(id, cwd) : await codexHistory(id);
  return events.length > MAX_EVENTS
    ? [{ type: 'notice', level: 'info', text: `历史过长，仅显示最近 ${MAX_EVENTS} 条` }, ...events.slice(-MAX_EVENTS)]
    : events;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 120);

/** Removes harness-injected wrappers from a user message; returns null if nothing user-authored remains. */
function cleanUserText(text: string): { kind: 'user' | 'notice'; text: string } | null {
  const command = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return { kind: 'user', text: `${command[1].trim()}${args ? ` ${args}` : ''}` };
  }
  const stdout = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (stdout) return stdout[1].trim() ? { kind: 'notice', text: truncate(stdout[1].trim(), 600) } : null;
  if (text.includes('<local-command-caveat>')) return null;
  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();
  if (!cleaned) return null;
  if (cleaned.startsWith('[Request interrupted')) return { kind: 'notice', text: '已中断' };
  return { kind: 'user', text: cleaned };
}

type Block = { type: string; [k: string]: unknown };

async function claudeHistory(id: string, cwd: string): Promise<AgentEvent[]> {
  const messages = await getSessionMessages(id, { dir: cwd });
  const out: AgentEvent[] = [];
  type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  let lastUsage: Usage | null = null;
  const tools = new Map<string, { name: string; input: unknown }>();

  for (const m of messages) {
    if (m.parent_tool_use_id) continue;
    const msg = m.message as { content?: string | Block[] };
    const content = msg?.content;

    if (m.type === 'user') {
      const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);
      const texts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') {
          const c = cleanUserText(b.text);
          if (c?.kind === 'notice') out.push({ type: 'notice', level: 'info', text: c.text });
          else if (c) texts.push(c.text);
        } else if (b.type === 'image') {
          texts.push('[图片]');
        } else if (b.type === 'tool_result') {
          const toolId = String(b.tool_use_id);
          const call = tools.get(toolId);
          tools.delete(toolId);
          out.push({
            type: 'tool_call',
            id: toolId,
            name: call?.name ?? 'tool',
            input: call?.input ?? {},
            status: b.is_error ? 'failed' : 'completed',
            output: truncate(resultText(b.content)),
          });
        }
      }
      if (texts.length) out.push({ type: 'user_message', text: texts.join('\n') });
    } else if (m.type === 'system' && (m.message as { subtype?: string } | null)?.subtype === 'compact_boundary') {
      lastUsage = null;
    } else if (m.type === 'assistant' && Array.isArray(content)) {
      const usage = (m.message as { usage?: Usage }).usage;
      if (usage) lastUsage = usage;
      content.forEach((b, i) => {
        const key = `${m.uuid}:${i}`;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ type: 'assistant_text', id: key, text: b.text });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          out.push({ type: 'thinking', id: key, text: b.thinking });
        } else if (b.type === 'tool_use') {
          const toolId = String(b.id);
          tools.set(toolId, { name: String(b.name), input: b.input });
          out.push({ type: 'tool_call', id: toolId, name: String(b.name), input: b.input, status: 'running' });
          if (b.name === 'TodoWrite') {
            const todos = (b.input as { todos?: { content?: string; status?: TodoEntry['status'] }[] })?.todos;
            if (Array.isArray(todos)) {
              out.push({
                type: 'todo',
                items: todos.map((t) => ({ text: t.content ?? '', status: t.status ?? 'pending' })),
              });
            }
          }
        }
      });
    }
  }
  if (lastUsage) {
    const u = lastUsage;
    const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    if (used) out.push({ type: 'context', used });
  }
  // Calls whose result never arrived (session ended mid-turn) should not look live.
  for (const [toolId, call] of tools) {
    out.push({ type: 'tool_call', id: toolId, name: call.name, input: call.input, status: 'failed', output: '（无结果）' });
  }
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[图片]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

interface CodexTurn {
  id: string;
  items: CodexItem[];
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message: string } | null;
  durationMs: number | null;
}

export type CodexItem = { type: string; id: string; [k: string]: unknown };

const codexStatus = (s: unknown): 'running' | 'completed' | 'failed' =>
  s === 'completed' ? 'completed' : s === 'inProgress' ? 'running' : 'failed';

async function codexHistory(id: string): Promise<AgentEvent[]> {
  const r: { thread: CodexThread } = await codexAppServer.call('thread/read', { threadId: id, includeTurns: true });
  const out: AgentEvent[] = [];
  for (const turn of r.thread.turns ?? []) {
    for (const item of turn.items) {
      const ev = codexItem(item);
      if (ev) out.push(ev);
    }
    if (turn.status !== 'inProgress') {
      out.push({
        type: 'turn_end',
        ok: turn.status === 'completed',
        error: turn.status === 'interrupted' ? '已中断' : turn.error?.message,
        durationMs: turn.durationMs ?? undefined,
      });
    }
  }
  const ctx = await codexContext(id).catch(() => null);
  if (ctx) out.push({ type: 'context', ...ctx });
  return out;
}

/** Converts one Codex app-server thread item into our event model (history and live turns). */
export function codexItem(item: CodexItem): AgentEvent | null {
  switch (item.type) {
    case 'userMessage': {
      const parts = (item.content as { type: string; text?: string; name?: string }[]).map((c) =>
        c.type === 'text' ? (c.text ?? '') : c.type.toLowerCase().includes('image') ? '[图片]' : c.name ? `@${c.name}` : '',
      );
      const text = parts.join('\n').trim();
      return text ? { type: 'user_message', text } : null;
    }
    case 'agentMessage':
      return String(item.text ?? '').trim() ? { type: 'assistant_text', id: item.id, text: String(item.text) } : null;
    case 'plan':
      return { type: 'assistant_text', id: item.id, text: `**计划**\n\n${item.text}` };
    case 'reasoning': {
      const text = [...((item.summary as string[]) ?? []), ...((item.content as string[]) ?? [])].join('\n\n').trim();
      return text ? { type: 'thinking', id: item.id, text } : null;
    }
    case 'commandExecution': {
      const exit = item.exitCode as number | null;
      return {
        type: 'tool_call',
        id: item.id,
        name: 'Bash',
        input: { command: item.command },
        status: codexStatus(item.status),
        output: truncate(String(item.aggregatedOutput ?? '')) + (exit ? `\n[退出码 ${exit}]` : ''),
      };
    }
    case 'fileChange': {
      const changes = (item.changes as { path: string; kind: unknown; diff?: string }[]) ?? [];
      const kindOf = (k: unknown) => (typeof k === 'string' ? k : ((k as { type?: string })?.type ?? 'update'));
      return {
        type: 'tool_call',
        id: item.id,
        name: 'Patch',
        input: { changes: changes.map((c) => ({ path: c.path, kind: kindOf(c.kind) })) },
        status: codexStatus(item.status),
        output: truncate(changes.map((c) => `${kindOf(c.kind)}: ${c.path}\n${c.diff ?? ''}`).join('\n')),
      };
    }
    case 'mcpToolCall': {
      const result = item.result as { content?: { type?: string; text?: string }[] } | null;
      const error = item.error as { message?: string } | null;
      return {
        type: 'tool_call',
        id: item.id,
        name: `mcp:${item.server}/${item.tool}`,
        input: item.arguments,
        status: codexStatus(item.status),
        output: error?.message ?? truncate((result?.content ?? []).map((c) => c.text ?? `[${c.type}]`).join('\n')),
      };
    }
    case 'webSearch':
      return { type: 'tool_call', id: item.id, name: 'WebSearch', input: { query: item.query }, status: 'completed' };
    case 'contextCompaction':
      return { type: 'notice', level: 'info', text: '上下文已压缩' };
    default:
      return null;
  }
}
