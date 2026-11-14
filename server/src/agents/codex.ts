import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { CodexAppServer } from '../external/codexAppServer.js';
import { codexItem, type CodexItem } from '../external/history.js';
import { getModels } from '../external/models.js';
import { isViewableImage } from '../uploads.js';
import type { CodexApprovalPolicy, CodexSandboxMode, EffortLevel, PermissionAnswer, QuestionSpec } from '../shared/protocol.js';
import { accountPrompt, codexAccountConfig } from './account.js';
import { describeFiles, truncate, type AgentHost, type AgentRunner, type FileRef } from './types.js';
import { webContext } from './webContext.js';

/** turn/start's sandboxPolicy for a sandbox mode. */
const SANDBOX_POLICIES: Record<CodexSandboxMode, { type: string }> = {
  'read-only': { type: 'readOnly' },
  'workspace-write': { type: 'workspaceWrite' },
  'danger-full-access': { type: 'dangerFullAccess' },
};

/**
 * OpenAI is temporarily out of capacity for the model (also when compacting). Codex retries
 * a few times on its own; after that we wait longer and try the turn again.
 */
const isCapacityError = (msg?: string | null) =>
  !!msg && /at capacity|overloaded|server is busy|try a different model|temporarily unavailable/i.test(msg);
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000];
const CONTINUE_PROMPT = '（上一轮因为模型暂时满载中断了。请从中断的地方继续，已经完成的步骤不用重做。）';

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

type Params = Record<string, unknown>;

interface PendingRequest {
  method: string;
  params: Params;
  resolve: (result: unknown) => void;
}

interface TokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

interface Turn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message: string } | null;
  durationMs: number | null;
}

/**
 * Codex through `codex app-server` (JSON-RPC over stdio), one process per session.
 * Unlike `codex exec`, this streams replies as they are written and lets Codex ask
 * for approval, which is shown in the web UI like Claude's permission prompts.
 */
export class CodexRunner implements AgentRunner {
  private server: CodexAppServer;
  private threadId: string | null;
  private threadReady: Promise<string> | null = null;
  private queue: { text: string; files: FileRef[]; attempt?: number }[] = [];
  /** Waiting before an automatic retry; resolving with false cancels it. */
  private retryWait: ((go: boolean) => void) | null = null;
  /** How the last turn ended, and whether it produced anything before failing. */
  private lastTurn: Turn | null = null;
  private turnItems = 0;
  /** An error reported during the turn; shown with the turn's end instead of twice. */
  private turnError: string | null = null;
  private running = false;
  private turnId: string | null = null;
  private turnStart = 0;
  private turnDone: (() => void) | null = null;
  private pending = new Map<string, PendingRequest>();
  /** Items Codex has started, so approval prompts can show what they are about. */
  private items = new Map<string, CodexItem>();
  private commandOutput = new Map<string, string>();
  private lastUsage: TokenBreakdown | null = null;
  private window: number | undefined;
  private effort: EffortLevel | null;
  private modelChoice: string | null;
  private approvalPolicy: CodexApprovalPolicy;
  private sandboxMode: CodexSandboxMode;
  /** Sandbox changed while the thread was loaded; sent with the next turn (it then sticks). */
  private sandboxOverride: CodexSandboxMode | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private interrupted = false;
  /** Compaction runs as an internal turn; its completion is reported by compact() itself. */
  private compacting = false;

  constructor(private host: AgentHost) {
    this.threadId = host.resumeId;
    this.effort = host.options.effort ?? null;
    this.modelChoice = host.options.model || null;
    this.approvalPolicy = host.options.approvalPolicy ?? 'on-request';
    // Members have nothing to do on this machine: its sandbox stays read-only whatever is chosen.
    this.sandboxMode = host.account ? 'read-only' : (host.options.sandboxMode ?? 'workspace-write');
    this.server = new CodexAppServer({
      env: { ...process.env, ANYWHERE_CODING: '1' },
      // Lets Codex ask multiple-choice questions (request_user_input) outside Plan mode too;
      // without it Codex only lists the choices as text and ends its turn. Only this
      // process is affected, not ~/.codex/config.toml or the terminal CLI.
      // Members: no local shell or other local tool, none of the machine owner's memories, apps, plugins
      // or MCP servers; the remote MCP server (their own computer) instead.
      config: ['features.default_mode_request_user_input=true', ...(host.account ? codexAccountConfig(host.account, host.uploadsDir) : [])],
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: (err) => this.onServerExit(err),
    });
    this.server.onNotification((method, params) => this.onNotification(method, params));
  }

  get busy() {
    return this.running;
  }

  /** A switched sandbox, sent with the next turn. */
  private sandboxPolicy(mode: CodexSandboxMode) {
    return SANDBOX_POLICIES[mode];
  }

  send(text: string, files: FileRef[] = []) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.queue.push({ text, files });
    // A new message replaces a pending automatic retry.
    this.retryWait?.(false);
    if (!this.running) void this.loop();
  }

  async setEffort(effort: EffortLevel | null) {
    this.effort = effort; // applied from the next turn
  }

  async setModel(model: string | null) {
    this.modelChoice = model; // applied from the next turn
  }

  /**
   * "Default" is sent explicitly: a resumed thread otherwise keeps whatever model and
   * effort its previous turn used instead of falling back to ~/.codex/config.toml.
   */
  private async turnSettings(): Promise<{ model: string | null; effort: EffortLevel | null }> {
    const codex = await getModels()
      .then((m) => m.codex)
      .catch(() => null);
    const model =
      this.modelChoice ?? codex?.configuredModel ?? codex?.models.find((m) => m.isDefault)?.id ?? null;
    const option = codex?.models.find((m) => m.id === model);
    const effort =
      this.effort ??
      (option && codex?.configuredEffort && option.efforts.includes(codex.configuredEffort as EffortLevel)
        ? (codex.configuredEffort as EffortLevel)
        : (option?.defaultEffort ?? null));
    return { model, effort };
  }

  async setApprovalPolicy(policy: CodexApprovalPolicy) {
    this.approvalPolicy = policy; // applied from the next turn
  }

  setSandboxMode(mode: CodexSandboxMode) {
    if (this.host.account) return;
    this.sandboxMode = mode;
    // A thread loaded later (after an idle close) picks it up from thread/resume instead.
    this.sandboxOverride = this.threadReady ? mode : null;
  }

  async interrupt() {
    this.queue = [];
    this.interrupted = true;
    this.retryWait?.(false);
    this.cancelPending('已中断');
    if (this.threadId && this.turnId) {
      await this.server.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    }
  }

  async compact() {
    if (this.running) throw new Error('会话正在运行，请等它结束后再压缩');
    if (!this.threadId) throw new Error('会话还没有内容，不需要压缩');
    this.running = true;
    this.compacting = true;
    const before = this.lastUsage?.totalTokens;
    try {
      const threadId = await this.ensureThread();
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => (off(), reject(new Error('压缩超时'))), 10 * 60 * 1000);
        const off = this.server.onNotification((method, params) => {
          if (params.threadId !== threadId || (method !== 'thread/compacted' && method !== 'turn/completed')) return;
          clearTimeout(timer);
          off();
          resolve();
        });
      });
      await this.server.call('thread/compact/start', { threadId });
      await done;
      const after = this.lastUsage?.totalTokens;
      this.host.emit({
        type: 'notice',
        level: 'info',
        text: `上下文已压缩${before && after && after !== before ? `：${fmtK(before)} → ${fmtK(after)} tokens` : ''}`,
      });
    } catch (e) {
      this.host.emit({ type: 'notice', level: 'error', text: `压缩失败: ${(e as Error).message}` });
    } finally {
      this.compacting = false;
      this.running = false;
      this.host.idle();
      if (this.queue.length) void this.loop();
      else this.scheduleIdleClose();
    }
  }

  answerPermission(a: PermissionAnswer): boolean {
    const p = this.pending.get(a.requestId);
    if (!p) return false;
    this.pending.delete(a.requestId);
    if (p.method === 'item/tool/requestUserInput') {
      const questions = (p.params.questions as { id: string; question: string }[]) ?? [];
      const answers = Object.fromEntries(
        questions.map((q) => [q.id, { answers: a.allow && a.answers?.[q.question] ? [a.answers[q.question]] : [] }]),
      );
      p.resolve({ answers });
    } else if (p.method === 'mcpServer/elicitation/request') {
      p.resolve({ action: a.allow ? 'accept' : 'decline', content: a.allow ? {} : null, _meta: a.allow && a.always ? { persist: 'session' } : null });
    } else {
      p.resolve({ decision: a.allow ? (a.always ? 'acceptForSession' : 'accept') : 'decline' });
    }
    this.host.emit({ type: 'permission_resolved', id: a.requestId, allow: a.allow, note: a.always ? '本会话始终允许' : undefined });
    if (!this.pending.size) this.host.waiting(false);
    return true;
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.queue = [];
    this.cancelPending('会话已关闭');
    this.server.stop();
    this.threadReady = null;
  }

  // ---------------------------------------------------------------- turns

  private ensureThread(): Promise<string> {
    if (this.threadReady && this.server.running) return this.threadReady;
    const common = {
      cwd: this.host.cwd,
      sandbox: this.sandboxMode,
      approvalPolicy: this.approvalPolicy,
      model: this.modelChoice,
      // Told only to agents this web service starts; plain `codex` sessions never see it.
      // A member's account memory goes with it, read afresh whenever the thread is (re)loaded.
      developerInstructions: [webContext(), this.host.account && accountPrompt(this.host.account)].filter(Boolean).join('\n\n'),
    };
    this.sandboxOverride = null; // the resume below already carries the current sandbox
    this.threadReady = (async () => {
      const r = this.threadId
        ? await this.server.call<{ thread: { id: string } }>('thread/resume', { threadId: this.threadId, excludeTurns: true, ...common })
        : await this.server.call<{ thread: { id: string } }>('thread/start', common);
      if (r.thread.id !== this.threadId) {
        this.threadId = r.thread.id;
        this.host.emit({ type: 'session_info', agentSessionId: r.thread.id });
      }
      return r.thread.id;
    })();
    this.threadReady.catch(() => (this.threadReady = null));
    return this.threadReady;
  }

  private async loop() {
    this.running = true;
    while (this.queue.length) {
      const { text, files, attempt = 0 } = this.queue.shift()!;
      this.interrupted = false;
      this.turnStart = Date.now();
      this.lastTurn = null;
      this.turnItems = 0;
      this.turnError = null;
      try {
        const threadId = await this.ensureThread();
        const finished = new Promise<void>((resolve) => (this.turnDone = resolve));
        const { model, effort } = await this.turnSettings();
        const images = files.filter((f) => isViewableImage(f.mime));
        const r = await this.server.call<{ turn: Turn }>('turn/start', {
          threadId,
          input: [
            { type: 'text', text: files.length ? describeFiles(text, files, (f) => isViewableImage(f.mime), !!this.host.account) : text, text_elements: [] },
            ...images.map((f) => ({ type: 'localImage', path: f.path })),
          ],
          approvalPolicy: this.approvalPolicy,
          ...(this.sandboxOverride && { sandboxPolicy: this.sandboxPolicy(this.sandboxOverride) }),
          effort,
          model,
        });
        this.sandboxOverride = null;
        this.turnId = r.turn.id;
        await finished;
        // Set by the turn/completed notification while we were waiting.
        const last = this.lastTurn as Turn | null;
        const failed = last?.status === 'failed' ? (last.error?.message ?? '') : null;
        if (failed !== null && isCapacityError(failed) && !this.interrupted && !this.queue.length && attempt < RETRY_DELAYS_MS.length) {
          await this.retryLater(attempt, text, files);
        }
      } catch (e) {
        this.turnDone = null;
        this.host.emit({
          type: 'turn_end',
          ok: false,
          error: this.interrupted ? '已中断' : (e as Error).message,
          durationMs: Date.now() - this.turnStart,
        });
      }
      this.turnId = null;
    }
    this.running = false;
    this.host.idle();
    this.scheduleIdleClose();
  }

  /** Waits, then queues the failed turn again: the same message, or "continue" if it had got going. */
  private async retryLater(attempt: number, text: string, files: FileRef[]) {
    const delay = RETRY_DELAYS_MS[attempt];
    this.host.emit({
      type: 'notice',
      level: 'info',
      text: `模型暂时满载，${delay / 1000} 秒后自动重试（第 ${attempt + 1}/${RETRY_DELAYS_MS.length} 次）。点「停止」可以取消，也可以在输入框下方换一个模型。`,
    });
    const go = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), delay);
      this.retryWait = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
    });
    this.retryWait = null;
    if (!go || this.interrupted) return;
    this.queue.unshift(this.turnItems > 0 ? { text: CONTINUE_PROMPT, files: [], attempt: attempt + 1 } : { text, files, attempt: attempt + 1 });
  }

  private scheduleIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.running) return;
      this.server.stop();
      this.threadReady = null;
    }, config.agentIdleMs);
  }

  private onServerExit(err: Error) {
    this.threadReady = null;
    this.cancelPending('Codex 进程已退出');
    if (this.turnDone) {
      this.host.emit({ type: 'turn_end', ok: false, error: err.message, durationMs: Date.now() - this.turnStart });
      const done = this.turnDone;
      this.turnDone = null;
      done();
    }
  }

  // ---------------------------------------------------------------- events from Codex

  private onNotification(method: string, p: Params) {
    if (p.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case 'turn/started':
        this.turnId = ((p.turn as Turn | undefined)?.id ?? this.turnId) as string | null;
        return;

      case 'item/started': {
        const item = p.item as CodexItem;
        this.items.set(item.id, item);
        // Show running commands and patches right away; text arrives as deltas.
        if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall') {
          const ev = codexItem(item);
          if (ev) this.host.emit(ev);
        }
        return;
      }

      case 'item/agentMessage/delta':
        this.host.delta({ kind: 'text', text: String(p.delta ?? '') });
        return;

      case 'item/commandExecution/outputDelta': {
        const id = String(p.itemId);
        const out = (this.commandOutput.get(id) ?? '') + String(p.delta ?? '');
        this.commandOutput.set(id, out.slice(-8000));
        this.host.delta({ kind: 'tool_output', id, text: out.slice(-4000) });
        return;
      }

      case 'item/completed': {
        const item = p.item as CodexItem;
        this.items.delete(item.id);
        this.commandOutput.delete(item.id);
        if (item.type === 'userMessage') return; // already shown when it was sent
        this.turnItems++;
        if (item.type === 'contextCompaction' && this.compacting) return; // compact() reports it with numbers
        const ev = codexItem(item);
        if (ev) this.host.emit(ev);
        return;
      }

      case 'thread/tokenUsage/updated': {
        const usage = p.tokenUsage as { last: TokenBreakdown; modelContextWindow: number | null };
        this.lastUsage = usage.last;
        this.window = usage.modelContextWindow ?? this.window;
        this.host.emit({ type: 'context', used: usage.last.totalTokens, window: this.window });
        return;
      }

      case 'error': {
        if (p.willRetry) return;
        const text = (p.error as { message?: string })?.message ?? 'Codex 出错';
        // During a turn, the turn's own end usually reports the same error; show it once.
        if (this.turnId && !this.compacting) this.turnError = text;
        else this.host.emit({ type: 'notice', level: 'error', text });
        return;
      }

      case 'turn/completed': {
        if (this.compacting) return;
        const turn = p.turn as Turn;
        this.lastTurn = turn;
        if (this.turnError && this.turnError !== turn.error?.message) {
          this.host.emit({ type: 'notice', level: 'error', text: this.turnError });
        }
        this.turnError = null;
        const u = this.lastUsage;
        this.host.emit({
          type: 'turn_end',
          ok: turn.status === 'completed',
          error:
            turn.status === 'interrupted' ? '已中断' : turn.status === 'failed' ? (turn.error?.message ?? '失败') : undefined,
          durationMs: turn.durationMs ?? Date.now() - this.turnStart,
          usage: u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedInputTokens } : undefined,
        });
        this.cancelPending('本轮已结束');
        const done = this.turnDone;
        this.turnDone = null;
        done?.();
        return;
      }
    }
  }

  /** Requests Codex sends us; approvals wait for the user's decision in the web UI. */
  private onRequest(method: string, params: Params): Promise<unknown> {
    // A member's Codex has no business on this machine: whatever would run or write here is refused, not asked.
    if (this.host.account && (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval')) {
      this.host.emit({ type: 'notice', level: 'error', text: '已拦截：这个账号只能操作它自己的电脑，不能在服务器上执行命令或修改文件' });
      return Promise.resolve({ decision: 'decline' });
    }
    switch (method) {
      // Calls to MCP tools (a member's remote tools among them) come as elicitations: shown like any other approval.
      case 'mcpServer/elicitation/request': {
        const meta = (params._meta ?? {}) as { codex_approval_kind?: string; tool_params?: unknown };
        if (meta.codex_approval_kind !== 'mcp_tool_call') break;
        const tool = String(params.message ?? '').match(/tool "([^"]+)"/)?.[1] ?? 'tool';
        return this.ask(method, params, { toolName: `mcp__${String(params.serverName)}__${tool}`, input: meta.tool_params ?? {} });
      }

      case 'item/commandExecution/requestApproval':
        return this.ask(method, params, {
          toolName: 'Bash',
          input: { command: params.command, cwd: params.cwd },
          reason: params.reason as string | undefined,
        });

      case 'item/fileChange/requestApproval': {
        const item = this.items.get(String(params.itemId));
        const changes = (item?.changes as { path: string; kind: unknown; diff?: string }[] | undefined) ?? [];
        return this.ask(method, params, {
          toolName: 'Patch',
          input: {
            changes: changes.map((c) => ({ path: c.path, kind: typeof c.kind === 'string' ? c.kind : (c.kind as { type?: string })?.type })),
            diff: truncate(changes.map((c) => c.diff ?? '').join('\n'), 8000),
          },
          reason: (params.reason as string | undefined) ?? (params.grantRoot ? `允许写入 ${params.grantRoot}` : undefined),
        });
      }

      case 'item/tool/requestUserInput': {
        const questions = (
          (params.questions as { question: string; header: string; isSecret?: boolean; options: { label: string; description: string }[] | null }[]) ?? []
        ).map((q): QuestionSpec => ({ question: q.question, header: q.header, secret: q.isSecret, options: q.options ?? [] }));
        return this.ask(method, params, { toolName: 'AskUserQuestion', input: params, questions });
      }

    }
    // Extra permission profiles, other MCP elicitations, auth refresh, …: not supported from the web UI.
    this.host.emit({ type: 'notice', level: 'info', text: `Codex 请求了网页端暂不支持的操作（${method}），已自动拒绝` });
    return Promise.reject(new Error(`not supported by Anywhere Coding: ${method}`));
  }

  private ask(
    method: string,
    params: Params,
    view: { toolName: string; input: unknown; reason?: string; questions?: QuestionSpec[] },
  ): Promise<unknown> {
    const id = randomUUID();
    this.host.emit({ type: 'permission_request', id, ...view });
    this.host.waiting(true);
    return new Promise((resolve) => this.pending.set(id, { method, params, resolve }));
  }

  private cancelPending(note: string) {
    for (const [id, p] of this.pending) {
      p.resolve(
        p.method === 'item/tool/requestUserInput'
          ? { answers: {} }
          : p.method === 'mcpServer/elicitation/request'
            ? { action: 'cancel', content: null, _meta: null }
            : { decision: 'cancel' },
      );
      this.host.emit({ type: 'permission_resolved', id, allow: false, note });
    }
    if (this.pending.size) this.host.waiting(false);
    this.pending.clear();
  }
}
