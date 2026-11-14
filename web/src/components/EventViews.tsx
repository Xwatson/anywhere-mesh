import { memo, useRef, useState, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { AgentEvent, PermissionAnswer, QuestionSpec, TodoEntry } from '../../../server/src/shared/protocol';
import { Button, CopyButton, cx, Icon } from './ui';

type ToolCall = Extract<AgentEvent, { type: 'tool_call' }>;
type PermRequest = Extract<AgentEvent, { type: 'permission_request' }>;

/** Fenced code block with a header showing the language and a copy button. */
function CodeBlock({ node, children, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null);
  const code = (node as { children?: { properties?: { className?: unknown } }[] } | undefined)?.children?.[0];
  const cls = code?.properties?.className;
  const lang = (Array.isArray(cls) ? cls : [])
    .map(String)
    .find((c) => c.startsWith('language-'))
    ?.slice('language-'.length);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="truncate">{lang ?? ''}</span>
        <CopyButton label text={() => (ref.current?.textContent ?? '').replace(/\n$/, '')} />
      </div>
      <pre ref={ref} {...props}>
        {children}
      </pre>
    </div>
  );
}

const mdComponents: Components = { pre: CodeBlock };
const remarkPlugins = [remarkGfm];
// Only fences with an explicit language get highlighted (no auto-detect); unknown languages stay plain.
const rehypePlugins = [rehypeHighlight];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md text-[15px]">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

const rel = (p: unknown, cwd: string) =>
  typeof p === 'string' ? (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p) : '';

/**
 * A member account's tools on its own computer (Claude: mcp__remote__x, Codex: mcp:remote/x), shown
 * like their local counterparts: `as` is the built-in tool they correspond to.
 */
const REMOTE_TOOLS: Record<string, { as: string; label: string; ask: string }> = {
  run: { as: 'Bash', label: '电脑 · 命令', ask: '请求在他的电脑上执行命令' },
  read_file: { as: 'Read', label: '电脑 · 读取', ask: '请求读取他电脑上的文件' },
  write_file: { as: 'Write', label: '电脑 · 写入', ask: '请求写入他电脑上的文件' },
  edit_file: { as: 'Edit', label: '电脑 · 修改', ask: '请求修改他电脑上的文件' },
  send_attachment: { as: '', label: '附件 → 电脑', ask: '请求把附件传到他的电脑上' },
  read_attachment: { as: '', label: '读取附件', ask: '请求读取附件' },
  memory_edit: { as: 'Edit', label: '记忆', ask: '请求更新记忆' },
  memory_write: { as: 'Write', label: '记忆', ask: '请求重写记忆' },
};

export function remoteTool(name: string) {
  const m = name.match(/^mcp(?:__|:)remote(?:__|\/)(\w+)$/);
  return m ? (REMOTE_TOOLS[m[1]] ?? null) : null;
}

/** One-line description of what a tool call does. */
export function toolSummary(name: string, input: unknown, cwd: string): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const remote = remoteTool(name);
  if (remote?.label === '记忆') return '更新这个账号的记忆';
  if (remote?.as) return toolSummary(remote.as, input, cwd);
  switch (name) {
    case 'Bash':
      return String(i.command ?? '').replace(/^\/bin\/(ba)?sh -lc /, '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return rel(i.file_path ?? i.notebook_path, cwd);
    case 'Glob':
    case 'Grep':
      return String(i.pattern ?? '');
    case 'WebFetch':
      return String(i.url ?? '');
    case 'WebSearch':
      return String(i.query ?? '');
    case 'Task':
    case 'Agent':
      return String(i.description ?? '');
    case 'Patch':
      return ((i.changes as { path: string; kind: string }[]) ?? []).map((c) => rel(c.path, cwd)).join(', ');
    case 'TodoWrite':
      return '更新任务列表';
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string');
      return typeof first === 'string' ? first : '';
    }
  }
}

function Pre({ children, className, copy = true }: { children: string; className?: string; copy?: boolean }) {
  return (
    <div className="group relative">
      <pre
        className={cx(
          'max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-zinc-950 p-2.5 font-mono text-xs leading-relaxed text-zinc-300',
          copy && 'pr-9',
          className,
        )}
      >
        {children}
      </pre>
      {copy && children && (
        <CopyButton
          text={children}
          className="absolute right-1.5 top-1.5 bg-zinc-900/80 opacity-70 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        />
      )}
    </div>
  );
}

/** Tool input rendered in the most readable form for that tool. */
export function ToolInput({ name: shown, input }: { name: string; input: unknown }) {
  const i = (input ?? {}) as Record<string, unknown>;
  const name = remoteTool(shown)?.as || shown;
  if (name === 'Bash' && typeof i.command === 'string') {
    const cmd = i.command.replace(/^\/bin\/(ba)?sh -lc /, '').replace(/^'(.*)'$/s, '$1');
    return (
      <div className="group relative">
        <Pre copy={false} className="pr-9">{`$ ${cmd}`}</Pre>
        <CopyButton
          text={cmd}
          className="absolute right-1.5 top-1.5 bg-zinc-900/80 opacity-70 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        />
      </div>
    );
  }
  if (name === 'Patch' && typeof i.diff === 'string' && i.diff.trim()) {
    return <Pre>{i.diff}</Pre>;
  }
  if (name === 'Edit' && typeof i.old_string === 'string') {
    return (
      <div className="space-y-1">
        <Pre className="bg-red-950/40 text-red-200">{i.old_string}</Pre>
        <Pre className="bg-emerald-950/40 text-emerald-200">{String(i.new_string ?? '')}</Pre>
      </div>
    );
  }
  if (name === 'Write' && typeof i.content === 'string') return <Pre>{i.content}</Pre>;
  return <Pre>{JSON.stringify(input, null, 2)}</Pre>;
}

export function ToolCard({ ev, cwd, live }: { ev: ToolCall; cwd: string; live?: string }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(ev.name, ev.input, cwd);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 text-sm">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span
          className={cx(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            ev.status === 'running' ? 'bg-amber-400 animate-pulse' : ev.status === 'failed' ? 'bg-red-500' : 'bg-emerald-500',
          )}
        />
        <span className="shrink-0 font-medium text-zinc-200">{remoteTool(ev.name)?.label ?? ev.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">{summary}</span>
        <Icon name="chevron" className={cx('text-zinc-500 transition-transform', open && 'rotate-90')} />
      </button>
      {ev.status === 'running' && live && !open && <Pre copy={false} className="mx-3 mb-2 max-h-32">{live.slice(-1500)}</Pre>}
      {open && (
        <div className="space-y-2 border-t border-zinc-800 p-3">
          <ToolInput name={ev.name} input={ev.input} />
          {(ev.output ?? live) && (
            <>
              <div className="text-xs text-zinc-500">输出</div>
              <Pre className={ev.status === 'failed' ? 'text-red-300' : undefined}>{ev.output ?? live ?? ''}</Pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type Answer = (a: Omit<PermissionAnswer, 'requestId'>) => void;

function QuestionForm({ questions, onAnswer }: { questions: QuestionSpec[]; onAnswer: Answer }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const toggle = (q: QuestionSpec, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });

  const answers = Object.fromEntries(
    questions.map((q) => {
      const parts = [...(picked[q.question] ?? []), other[q.question]?.trim()].filter(Boolean);
      return [q.question, parts.join(', ')];
    }),
  );
  const complete = questions.every((q) => answers[q.question]);

  return (
    <div className="space-y-4">
      {questions.map((q) => (
        <div key={q.question} className="space-y-2">
          <div className="font-medium">{q.question}</div>
          <div className="space-y-1.5">
            {q.options.map((o) => {
              const on = picked[q.question]?.includes(o.label);
              return (
                <button
                  key={o.label}
                  onClick={() => toggle(q, o.label)}
                  className={cx(
                    'block w-full rounded-lg border px-3 py-2 text-left',
                    on ? 'border-emerald-500 bg-emerald-500/10' : 'border-zinc-700 hover:border-zinc-500',
                  )}
                >
                  <div className="text-sm">{o.label}</div>
                  {o.description && <div className="text-xs text-zinc-400">{o.description}</div>}
                </button>
              );
            })}
            <input
              type={q.secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={q.secret ? '输入内容（不会显示）' : q.options.length ? '其他（自己填写）' : '输入你的回答'}
              value={other[q.question] ?? ''}
              onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="primary" disabled={!complete} onClick={() => onAnswer({ allow: true, answers })}>
          提交回答
        </Button>
        <Button onClick={() => onAnswer({ allow: false, message: 'The user declined to answer.' })}>跳过</Button>
      </div>
    </div>
  );
}

export function PermissionCard({
  ev,
  cwd,
  onAnswer,
  waitingFor,
}: {
  ev: PermRequest;
  cwd: string;
  onAnswer: Answer;
  /** Watching another account's session: show the request, its owner answers it. */
  waitingFor?: string;
}) {
  const [feedback, setFeedback] = useState('');
  const input = (ev.input ?? {}) as Record<string, unknown>;
  const isPlan = ev.toolName === 'ExitPlanMode';

  return (
    <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2 text-sm text-amber-300">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
        {ev.questions
          ? 'AI 有问题想问你'
          : isPlan
            ? 'Claude 提交了实施计划'
            : ev.title ||
              remoteTool(ev.toolName)?.ask ||
              (ev.toolName === 'Bash' ? '请求执行命令' : ev.toolName === 'Patch' ? '请求修改文件' : `请求使用 ${ev.toolName}`)}
      </div>

      {ev.questions && waitingFor !== undefined ? (
        <>
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">
            {ev.questions.map((q, i) => (
              <li key={i}>{q.question}</li>
            ))}
          </ul>
          <div className="text-xs text-zinc-500">等 {waitingFor} 回答</div>
        </>
      ) : ev.questions ? (
        <QuestionForm questions={ev.questions} onAnswer={onAnswer} />
      ) : (
        <>
          {isPlan && typeof input.plan === 'string' ? (
            <div className="max-h-[50dvh] overflow-y-auto rounded-lg bg-zinc-950 p-3">
              <Markdown text={input.plan} />
            </div>
          ) : (
            <>
              <div className="font-mono text-xs text-zinc-400">{toolSummary(ev.toolName, ev.input, cwd)}</div>
              <ToolInput name={ev.toolName} input={ev.input} />
            </>
          )}
          {ev.reason && <div className="text-xs text-zinc-500">{ev.reason}</div>}
          {waitingFor !== undefined ? (
            <div className="text-xs text-zinc-500">等 {waitingFor} 确认</div>
          ) : (
            <>
              <input
                placeholder={isPlan ? '修改意见（拒绝时发送给 Claude）' : '拒绝理由（可选）'}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => onAnswer({ allow: true })}>
                  {isPlan ? '批准计划' : '允许'}
                </Button>
                {!isPlan && <Button onClick={() => onAnswer({ allow: true, always: true })}>本会话始终允许</Button>}
                <Button variant="danger" onClick={() => onAnswer({ allow: false, message: feedback || undefined })}>
                  {isPlan ? '继续修改' : '拒绝'}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function TodoPanel({ items }: { items: TodoEntry[] }) {
  const [open, setOpen] = useState(false);
  const done = items.filter((t) => t.status === 'completed').length;
  const current = items.find((t) => t.status === 'in_progress');
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 text-sm">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left">
        <span className="text-zinc-400">
          任务 {done}/{items.length}
        </span>
        <span className="min-w-0 flex-1 truncate text-zinc-300">{current?.text}</span>
        <Icon name="chevron" className={cx('text-zinc-500 transition-transform', open ? 'rotate-90' : '-rotate-90')} />
      </button>
      {open && (
        <ul className="max-h-48 space-y-1 overflow-y-auto border-t border-zinc-800 px-3 py-2">
          {items.map((t, i) => (
            <li key={i} className="flex gap-2">
              <span className={t.status === 'completed' ? 'text-emerald-400' : t.status === 'in_progress' ? 'text-amber-400' : 'text-zinc-600'}>
                {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'}
              </span>
              <span className={cx(t.status === 'completed' && 'text-zinc-500 line-through')}>{t.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
