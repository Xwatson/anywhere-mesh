import { randomUUID } from 'node:crypto';
import {
  query,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { claudeHoldersElsewhere } from '../external/holders.js';
import type { ClaudePermissionMode, EffortLevel, PermissionAnswer, QuestionSpec, TodoEntry } from '../shared/protocol.js';

type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const CLAUDE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const asClaudeEffort = (e: EffortLevel | null | undefined): ClaudeEffort | null =>
  e && CLAUDE_EFFORTS.includes(e) ? (e as ClaudeEffort) : null;
import { isViewableImage } from '../uploads.js';
import { describeFiles, truncate, type AgentHost, type AgentRunner, type FileRef } from './types.js';
import { accountPrompt, MEMBER_CLAUDE_TOOLS, MEMBER_TOOL_ALIASES, memberToolProblem, remoteMcpLaunch } from './account.js';
import { ADVISOR_WRITE_REASON, advisorMemoryContext, advisorPrompt, WRITE_TOOLS, writeOutsideMemory } from './advisor.js';
import { isSelfTermination, SELF_TERMINATION_REASON, webContext } from './webContext.js';

const MAX_INLINE_IMAGE = 5 * 1024 * 1024;
const inlineImage = (f: FileRef) => isViewableImage(f.mime) && statSync(f.path).size <= MAX_INLINE_IMAGE;

/** PDFs sent with the message: within the API's limits, and short enough not to flood the context. */
const MAX_INLINE_PDF = 20 * 1024 * 1024;
const MAX_INLINE_PDF_PAGES = 50;
function inlinablePdf(f: FileRef): boolean {
  if (f.mime !== 'application/pdf' || statSync(f.path).size > MAX_INLINE_PDF) return false;
  try {
    // Unknown page count (no pdfinfo, damaged file): not inlined, read on demand instead.
    const pages = Number(execFileSync('pdfinfo', [f.path], { timeout: 10_000, encoding: 'utf8' }).match(/^Pages:\s+(\d+)/m)?.[1]);
    return pages > 0 && pages <= MAX_INLINE_PDF_PAGES;
  } catch {
    return false;
  }
}

/**
 * Message content with images inline (the model sees them directly) and other files by path.
 * Members' sessions have no file tool on this server, so their PDFs go inline too (scans included).
 */
function userContent(text: string, files: FileRef[], member: boolean) {
  const pdfs = member ? files.filter(inlinablePdf) : [];
  const inline = (f: FileRef) => inlineImage(f) || pdfs.includes(f);
  return [
    { type: 'text' as const, text: describeFiles(text, files, inline, member) },
    ...files.filter(inlineImage).map((f) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: f.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: readFileSync(f.path).toString('base64'),
      },
    })),
    ...pdfs.map((f) => ({
      type: 'document' as const,
      title: f.name,
      source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: readFileSync(f.path).toString('base64') },
    })),
  ];
}

const LOG_DIR = join(config.dataDir, 'logs');
const KEEP_LOGS = 40;

/** A debug log per agent process (~25 KB), so failures such as API errors can be diagnosed. */
/**
 * Whether Claude Code still has its record of a conversation. It deletes the ones nobody touched for
 * `cleanupPeriodDays` (30 days by default), and resuming one of those fails at once.
 */
function transcriptExists(id: string, cwd: string): boolean {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const file = `${id}.jsonl`;
  if (existsSync(join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), file))) return true;
  // Long or unusual folder names are stored under another name: look through every project.
  try {
    return readdirSync(projects).some((d) => existsSync(join(projects, d, file)));
  } catch {
    return true; // cannot tell: resume as usual
  }
}

function newDebugLog(sessionId: string | null): string {
  mkdirSync(LOG_DIR, { recursive: true });
  const files = readdirSync(LOG_DIR)
    .filter((f) => f.startsWith('claude-'))
    .map((f) => ({ f, t: statSync(join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(KEEP_LOGS - 1)) unlinkSync(join(LOG_DIR, f));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(LOG_DIR, `claude-${stamp}-${(sessionId ?? 'new').slice(0, 8)}.log`);
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Push-based async iterable feeding user messages into a long-lived query. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(msg: SDKUserMessage) {
    this.items.push(msg);
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

interface PendingPermission {
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[图片]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export class ClaudeRunner implements AgentRunner {
  private q: Query | null = null;
  private input: InputQueue | null = null;
  private abort: AbortController | null = null;
  private pending = new Map<string, PendingPermission>();
  private tools = new Map<string, { name: string; input: unknown }>();
  private sessionId: string | null;
  private running = false;
  private turnStart = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Live background tasks (shells, subagents, monitors) Claude Code reports, ambient ones left out. */
  private backgroundTasks = 0;
  private mode: ClaudePermissionMode;
  private interrupted = false;
  private effort: ClaudeEffort | null;
  private model: string | null = null;
  /** Whether the web-host note was already added for the current agent process. */
  private contextSent = false;
  /** Advisor sessions: whether the memory was handed over since the process started or last compacted. */
  private memorySent = false;
  /**
   * total_cost_usd is cumulative for the agent process (and a resumed session starts from
   * its saved total), so per-turn cost is the difference from the previous result.
   * null = baseline unknown until the first result of a resumed process.
   */
  private costBase: number | null = 0;
  /** Messages sent but not yet answered, so a turn rejected before it ran can be retried. */
  private inFlight: { text: string; files: FileRef[]; retried: boolean }[] = [];
  /** Model picked in the web UI; null = Claude Code's default. */
  private modelChoice: string | null;
  /** Usage of the latest top-level model call; its input side is the context size. */
  private lastUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null = null;

  constructor(private host: AgentHost) {
    this.sessionId = host.resumeId;
    this.mode = host.options.permissionMode ?? 'default';
    this.effort = asClaudeEffort(host.options.effort);
    this.modelChoice = host.options.model || null;
  }

  async setModel(model: string | null) {
    this.modelChoice = model;
    if (this.q) await this.q.setModel(model ?? undefined);
  }

  get busy() {
    return this.running;
  }

  send(text: string, files: FileRef[] = [], isRetry = false) {
    this.inFlight.push({ text, files, retried: isRetry });
    this.clearIdleTimer();
    if (!this.q) this.start();
    if (!this.running) this.turnStart = Date.now();
    this.running = true;
    this.input!.push({
      type: 'user',
      message: { role: 'user', content: files.length ? userContent(text, files, !!this.host.account) : text },
      parent_tool_use_id: null,
    });
  }

  async interrupt() {
    this.denyAllPending('已中断');
    if (this.q && this.running) {
      this.interrupted = true;
      await this.q.interrupt();
    }
  }

  async setPermissionMode(mode: ClaudePermissionMode) {
    this.mode = mode;
    if (this.q) await this.q.setPermissionMode(mode);
  }

  async setEffort(effort: EffortLevel | null) {
    this.effort = asClaudeEffort(effort);
    // Session-scoped override; null falls back to the user's configured default.
    if (this.q) await this.q.applyFlagSettings({ effortLevel: this.effort });
  }

  async compact() {
    if (this.running) throw new Error('会话正在运行，请等它结束后再压缩');
    // Claude Code's own /compact command, exactly as typed in the CLI.
    this.send('/compact');
  }

  answerPermission(a: PermissionAnswer): boolean {
    const p = this.pending.get(a.requestId);
    if (!p) return false;
    this.pending.delete(a.requestId);
    if (a.allow) {
      p.resolve({
        behavior: 'allow',
        updatedInput: a.answers ? { ...p.input, answers: a.answers } : p.input,
        updatedPermissions: a.always ? p.suggestions : undefined,
      });
    } else {
      p.resolve({ behavior: 'deny', message: a.message || 'The user denied this action.' });
    }
    this.host.emit({ type: 'permission_resolved', id: a.requestId, allow: a.allow, note: a.always ? '本会话始终允许' : undefined });
    if (!this.pending.size) this.host.waiting(false);
    return true;
  }

  close() {
    this.clearIdleTimer();
    this.denyAllPending('会话已关闭');
    this.input?.end();
    this.abort?.abort();
    this.q?.close();
    this.q = null;
    this.input = null;
  }

  private denyAllPending(note: string) {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'The user interrupted.', interrupt: true });
      this.host.emit({ type: 'permission_resolved', id, allow: false, note });
    }
    if (this.pending.size) this.host.waiting(false);
    this.pending.clear();
  }

  private clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Closes the agent process after a quiet spell; the next message resumes it. Arming again
   * replaces the previous timer, so an older one can never fire in the middle of later work.
   */
  private armIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Background shells, subagents and monitors still need the process: look again later.
      if (this.running || this.backgroundTasks > 0) return this.armIdleTimer();
      this.close();
    }, config.agentIdleMs);
  }

  /**
   * Claude Code also starts turns by itself: when a background task finishes, a message
   * arrives from another session, or a scheduled wakeup fires. Track those like turns sent
   * from here, so the session shows as running, the restart dialog counts it, and the idle
   * timer cannot close the process in the middle of the work.
   */
  private markActive() {
    if (this.running) return;
    this.running = true;
    this.turnStart = Date.now();
    this.clearIdleTimer();
    // Running, or waiting while a permission request is open.
    this.host.waiting(this.pending.size > 0);
  }

  private debugLog = '';

  private start() {
    // The record of a long-unused conversation may be gone: start a new one rather than fail at every message.
    if (this.sessionId && !transcriptExists(this.sessionId, this.host.cwd)) {
      this.sessionId = null;
      this.host.emit({
        type: 'notice',
        level: 'info',
        text: 'Claude Code 里这个会话的对话记录已经不在了（超过 30 天没用的会被自动清理），AI 不记得之前聊过的内容，从这里开始是一段新对话。上面的聊天记录仍然保留。',
      });
    }
    this.contextSent = false;
    this.memorySent = false;
    const advisor = this.host.advisor;
    const account = this.host.account;
    // Role (advisor) and a member's environment and memory on top of Claude Code's own prompt; read at every process start.
    const append = [advisor && advisorPrompt(advisor), account && accountPrompt(account)].filter(Boolean).join('\n\n');
    // Claude Code reports background tasks per process and sends nothing at startup.
    this.backgroundTasks = 0;
    this.debugLog = newDebugLog(this.sessionId);
    this.costBase = this.sessionId ? null : 0;
    this.input = new InputQueue();
    this.abort = new AbortController();
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.host.cwd,
        resume: this.sessionId ?? undefined,
        model: this.modelChoice ?? undefined,
        effort: this.effort ?? undefined,
        // Uploaded attachments live outside the project; let Claude read them without prompting.
        // The advisor's memory folder likewise: it is the only place the advisor may write.
        // (Members have no file tools here at all: their attachments and memory go through the remote tools.)
        additionalDirectories: account ? [] : advisor ? [this.host.uploadsDir, advisor.memoryDir] : [this.host.uploadsDir],
        systemPrompt: append ? { type: 'preset', preset: 'claude_code', append } : undefined,
        permissionMode: this.mode,
        allowDangerouslySkipPermissions: this.mode === 'bypassPermissions',
        includePartialMessages: true,
        abortController: this.abort,
        pathToClaudeCodeExecutable: config.claudePath,
        extraArgs: { 'debug-file': this.debugLog },
        // Members work only on their own computer: no built-in tool that acts on this machine (habitual
        // Bash / Read / Write / Edit calls are routed to the remote tools), the remote MCP server as the
        // only MCP server, and none of this machine's settings (~/.claude/CLAUDE.md, plugins, hooks,
        // permission rules, project files). Their memory comes with the system prompt instead, so Claude
        // Code's built-in auto memory stays off.
        settingSources: account ? [] : ['user', 'project', 'local'],
        ...(account && {
          settings: { autoMemoryEnabled: false },
          tools: MEMBER_CLAUDE_TOOLS,
          toolAliases: MEMBER_TOOL_ALIASES,
          mcpServers: { remote: { type: 'stdio' as const, ...remoteMcpLaunch(account, this.host.uploadsDir) } },
          strictMcpConfig: true,
        }),
        canUseTool: (toolName, input, opts) => this.askPermission(toolName, input, opts),
        // Identifies this app in Claude Code's User-Agent and lets tools detect the web host.
        // Members: no claude.ai connectors either (they belong to the logged-in Claude account, the owner's).
        env: {
          ...process.env,
          ANYWHERE_CODING: '1',
          CLAUDE_AGENT_SDK_CLIENT_APP: 'anywhere-coding/0.1.0',
          ...(account && { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }),
        },
        // Registered only by the web service, so plain CLI sessions are unaffected.
        hooks: {
          // Added once per agent process, with the first prompt it receives.
          UserPromptSubmit: [
            {
              hooks: [
                async () => {
                  const parts: string[] = [];
                  if (!this.contextSent) {
                    this.contextSent = true;
                    parts.push(webContext());
                  }
                  // The advisor's memory: with the first prompt, and again after a compaction dropped it.
                  if (advisor && !this.memorySent) {
                    this.memorySent = true;
                    parts.push(advisorMemoryContext(advisor));
                  }
                  if (!parts.length) return {};
                  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } };
                },
              ],
            },
          ],
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                async (input) => {
                  const command = String((input as { tool_input?: { command?: unknown } }).tool_input?.command ?? '');
                  if (!isSelfTermination(command)) return {};
                  this.host.emit({ type: 'notice', level: 'error', text: `已拦截会重启/停止本服务的命令: ${command.slice(0, 200)}` });
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: SELF_TERMINATION_REASON,
                    },
                  };
                },
              ],
            },
            // A member's agent uses nothing that acts on this machine, in every permission mode (no matcher: every tool).
            ...(account
              ? [
                  {
                    hooks: [
                      async (input: unknown) => {
                        const { tool_name, tool_input } = input as { tool_name?: string; tool_input?: unknown };
                        const reason = await memberToolProblem(String(tool_name ?? ''), tool_input);
                        if (!reason) return {};
                        this.host.emit({ type: 'notice', level: 'error', text: `已拦截：${String(tool_name)} 会在服务器本机上运行，这个账号只能操作它自己的电脑` });
                        return {
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse' as const,
                            permissionDecision: 'deny' as const,
                            permissionDecisionReason: reason,
                          },
                        };
                      },
                    ],
                  },
                ]
              : []),
            // The advisor never edits the project: writes outside its memory folder are refused in every permission mode.
            ...(advisor
              ? [
                  {
                    matcher: WRITE_TOOLS,
                    hooks: [
                      async (input: unknown) => {
                        const target = writeOutsideMemory((input as { tool_input?: unknown }).tool_input, advisor);
                        if (!target) return {};
                        this.host.emit({ type: 'notice', level: 'error', text: `已拦截管家对项目文件的修改: ${target}` });
                        return {
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse' as const,
                            permissionDecision: 'deny' as const,
                            permissionDecisionReason: ADVISOR_WRITE_REASON,
                          },
                        };
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
        stderr: (d) => process.stderr.write(`[claude] ${d}`),
      },
    });
    void this.consume(this.q);
  }

  private askPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; title?: string; decisionReason?: string },
  ): Promise<PermissionResult> {
    const id = randomUUID();
    const questions =
      toolName === 'AskUserQuestion' && Array.isArray(input.questions) ? (input.questions as QuestionSpec[]) : undefined;
    this.host.emit({
      type: 'permission_request',
      id,
      toolName,
      input,
      title: opts.title,
      reason: opts.decisionReason,
      questions,
    });
    this.markActive();
    this.host.waiting(true);
    return new Promise((resolve) => {
      this.pending.set(id, { input, suggestions: opts.suggestions, resolve });
      opts.signal.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        this.host.emit({ type: 'permission_resolved', id, allow: false, note: '已取消' });
        if (!this.pending.size) this.host.waiting(false);
        resolve({ behavior: 'deny', message: 'Cancelled.' });
      });
    });
  }

  private async consume(q: Query) {
    try {
      for await (const msg of q) this.handle(msg);
    } catch (e) {
      if (!this.abort?.signal.aborted) {
        this.host.emit({ type: 'notice', level: 'error', text: `Claude 进程异常: ${e instanceof Error ? e.message : e}` });
      }
    } finally {
      if (this.q === q) {
        // The process ended by itself: nothing is left for the idle timer to close.
        this.q = null;
        this.input = null;
        this.backgroundTasks = 0;
        this.clearIdleTimer();
      }
      this.denyAllPending('进程已退出');
      if (this.running) {
        this.running = false;
        this.host.emit({ type: 'turn_end', ok: false, error: '进程已退出' });
      }
      this.host.idle();
    }
  }

  private handle(msg: SDKMessage) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.model = msg.model;
          if (msg.session_id !== this.sessionId) {
            this.sessionId = msg.session_id;
            this.host.emit({ type: 'session_info', agentSessionId: msg.session_id, model: msg.model });
          }
        } else if (msg.subtype === 'compact_boundary') {
          const { pre_tokens, post_tokens, trigger } = msg.compact_metadata;
          this.host.emit({
            type: 'notice',
            level: 'info',
            text: `${trigger === 'auto' ? '已自动压缩上下文' : '上下文已压缩'}：${fmtK(pre_tokens)}${post_tokens ? ` → ${fmtK(post_tokens)}` : ''} tokens`,
          });
          // Usage seen before the boundary no longer describes the context.
          this.lastUsage = null;
          // Neither does the advisor's memory: hand it over again with the next prompt.
          this.memorySent = false;
          if (post_tokens) this.host.emit({ type: 'context', used: post_tokens, window: this.window });
        } else if (msg.subtype === 'session_state_changed') {
          // Also reports turns Claude Code starts by itself.
          if (msg.state !== 'idle') this.markActive();
        } else if (msg.subtype === 'background_tasks_changed') {
          // The full current set each time, so a missed message cannot leave a stale count.
          this.backgroundTasks = msg.tasks.filter((t) => !t.ambient).length;
        }
        return;

      case 'stream_event': {
        if (msg.parent_tool_use_id) return;
        this.markActive();
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.host.delta({ kind: 'text', text: ev.delta.text });
        }
        return;
      }

      case 'assistant': {
        if (msg.parent_tool_use_id) return;
        this.markActive();
        if (msg.message.usage) this.lastUsage = msg.message.usage;
        msg.message.content.forEach((block, i) => {
          const id = `${msg.uuid}:${i}`;
          if (block.type === 'text' && block.text.trim()) {
            this.host.emit({ type: 'assistant_text', id, text: block.text });
          } else if (block.type === 'thinking' && block.thinking.trim()) {
            this.host.emit({ type: 'thinking', id, text: block.thinking });
          } else if (block.type === 'tool_use') {
            this.tools.set(block.id, { name: block.name, input: block.input });
            this.host.emit({ type: 'tool_call', id: block.id, name: block.name, input: block.input, status: 'running' });
            if (block.name === 'TodoWrite') this.emitTodos(block.input);
          }
        });
        return;
      }

      case 'user': {
        if (msg.parent_tool_use_id || typeof msg.message.content === 'string') return;
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue;
          const call = this.tools.get(block.tool_use_id);
          this.tools.delete(block.tool_use_id);
          this.host.emit({
            type: 'tool_call',
            id: block.tool_use_id,
            name: call?.name ?? 'tool',
            input: call?.input ?? {},
            status: block.is_error ? 'failed' : 'completed',
            output: truncate(toolResultText(block.content)),
          });
        }
        return;
      }

      case 'result': {
        const ok = msg.subtype === 'success' && !msg.is_error;
        this.host.emit({
          type: 'turn_end',
          ok,
          error: ok ? undefined : this.interrupted ? '已中断' : msg.subtype === 'success' ? msg.result : msg.subtype,
          durationMs: Date.now() - this.turnStart,
          costUsd: this.costBase === null ? undefined : Math.max(0, msg.total_cost_usd - this.costBase),
          usage: {
            // Reported like Codex: input includes cached tokens.
            inputTokens:
              msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
            outputTokens: msg.usage.output_tokens,
            cachedInputTokens: msg.usage.cache_read_input_tokens ?? undefined,
          },
        });
        this.costBase = msg.total_cost_usd;
        this.window = this.contextWindow(msg.modelUsage) ?? this.window;
        if (this.lastUsage) {
          const u = this.lastUsage;
          const used = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + u.output_tokens;
          // Error results carry a synthetic message with zero usage; keep the last real figure.
          if (used > 0) this.host.emit({ type: 'context', used, window: this.window });
        }

        const sent = this.inFlight.shift();
        const queued = msg.queued_turn_count ?? 0;
        if (!queued) this.inFlight = [];
        // An auth rejection that consumed no tokens never ran anything, so one automatic retry is safe.
        const authRejected =
          !ok &&
          !this.interrupted &&
          msg.subtype === 'success' &&
          /Failed to authenticate|API Error: 40[13]/.test(msg.result) &&
          msg.usage.output_tokens === 0;
        this.interrupted = false;
        if (authRejected) {
          // A 403 "Request not allowed" is what the API returns for unsupported regions: the service
          // most likely connects without the proxy the user's shell sets in ~/.bashrc.
          if (!process.env.HTTPS_PROXY && !process.env.https_proxy && !process.env.ALL_PROXY && !process.env.all_proxy) {
            this.host.emit({
              type: 'notice',
              level: 'error',
              text:
                '请求被拒绝（403）：服务进程没有配置网络代理。systemd 服务不会读取 ~/.bashrc 里的代理设置，' +
                '请把 HTTPS_PROXY / HTTP_PROXY / NO_PROXY 写进项目的 .env，然后重启服务。',
            });
          }
          const holders = this.sessionId ? claudeHoldersElsewhere(this.sessionId) : [];
          if (holders.length) {
            this.host.emit({
              type: 'notice',
              level: 'error',
              text: `这个会话同时在终端 Claude Code 中打开（PID ${holders.map((h) => h.pid).join(', ')}），被拒绝很可能与此有关。请先在终端里 /exit，再回来重试。`,
            });
          }
          this.host.emit({ type: 'notice', level: 'info', text: `诊断日志: ${this.debugLog}` });
        }
        if (authRejected && sent && !sent.retried && !queued) {
          this.host.emit({ type: 'notice', level: 'info', text: '请求被拒绝（认证错误，未执行任何操作），2 秒后自动重试一次…' });
          this.running = true;
          setTimeout(() => {
            if (this.q) return this.send(sent.text, sent.files, true);
            this.running = false;
            this.host.idle();
          }, 2000);
          return;
        }

        this.running = queued > 0;
        if (this.running) {
          this.turnStart = Date.now();
        } else {
          this.host.idle();
          this.armIdleTimer();
        }
        return;
      }
    }
  }

  private window: number | undefined;

  private contextWindow(usage: Record<string, { contextWindow: number }> | undefined): number | undefined {
    if (!usage) return undefined;
    const main = this.model ? usage[this.model] : undefined;
    if (main?.contextWindow) return main.contextWindow;
    const largest = Math.max(0, ...Object.values(usage).map((u) => u.contextWindow ?? 0));
    return largest || undefined;
  }

  private emitTodos(input: unknown) {
    const todos = (input as { todos?: { content?: string; status?: TodoEntry['status'] }[] })?.todos;
    if (!Array.isArray(todos)) return;
    this.host.emit({
      type: 'todo',
      items: todos.map((t) => ({ text: t.content ?? '', status: t.status ?? 'pending' })),
    });
  }
}
