import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServer } from './codex-app-server.mjs';
import { CATALOG, browserInstructions, listTools, normalize } from '../workspace/catalog.mjs';
import { assertIdentity } from '../execution/grants.mjs';
import { hash, string } from '../execution/protocol.mjs';
import {
  MEMORY_TOOLS,
  MEMORY_TOOL_NAMES,
  buildMemoryInstructions,
  executeMemoryTool,
} from './memory.mjs';
import {
  TurnToolGuard,
  appendCodexWarning,
  boundEventInput,
  isMutationTool,
  resolveToolBudget,
  summarizeCallArgs,
} from './tool-budget.mjs';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DEFAULT_MODELS = {
  models: [
    { id: 'gpt-5.4', name: 'GPT-5.4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', isDefault: true },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    { id: 'o3', name: 'o3', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  ],
};
const SESSION_TOOLS = [
  {
    name: 'session_read_attachment',
    description: 'Read a file attached by the user in this conversation (text, code, log, or PDF text). Specify attachmentId or name.',
    inputSchema: {
      type: 'object',
      properties: {
        attachment: { type: 'string', minLength: 1, maxLength: 200, description: 'Attachment ID or filename shown in the conversation.' },
        offset: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 },
        length: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
      },
      required: ['attachment'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_send_attachment',
    description: 'Copy a UTF-8 text attachment uploaded in this conversation into the bound project workspace (requires edit or full access).',
    inputSchema: {
      type: 'object',
      properties: {
        attachment: { type: 'string', minLength: 1, maxLength: 200, description: 'Attachment ID or filename.' },
        path: { type: 'string', minLength: 1, maxLength: 512, description: 'Destination path relative to workspace root.' },
        expectedRevision: { type: ['string', 'null'], pattern: '^file-v1:[a-f0-9]{64}$', description: 'Null to create a new file, or the last read revision to overwrite.' },
      },
      required: ['attachment', 'path', 'expectedRevision'],
      additionalProperties: false,
    },
  },
];

function deviceInstructions(hasAttachments) {
  const att = hasAttachments ? ' Use session_read_attachment/session_send_attachment for non-image attachments.' : '';
  return `The project is on a remote device; this host has no project files. Always use workspace_* tools with relative paths.${att}`;
}
function describeAttachments(text, atts) {
  if (!atts?.length) return text;
  const lines = atts.map(a => `- ${a.name} (id: ${a.id}, ${a.mime}, ${a.size} bytes${IMAGE_MIMES.has(a.mime) ? ', attached inline as image' : ''})`);
  return `${text}\n\n[Attached files]\n${lines.join('\n')}`;
}
function extractPdfText(filePath) {
  return new Promise((resolve, reject) =>
    execFile('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-'], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
}
const workspaceNames = new Set(CATALOG.map(tool => tool.name));
const failure = text => ({ success: false, contentItems: [{ type: 'inputText', text }] });
const turnScope = t => ({ sessionId: t.sessionId, turnId: t.binding.turnId, turnEpoch: t.binding.turnEpoch });

function parseEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}
function formatWindowMinutes(mins, fallback) {
  if (!Number.isFinite(mins) || mins <= 0) return fallback;
  if (mins % 10080 === 0) return `${(mins / 10080) * 7} 天窗口`;
  if (mins % 1440 === 0) return `${mins / 1440} 天窗口`;
  if (mins % 60 === 0) return `${mins / 60} 小时窗口`;
  return `${Math.round(mins)} 分钟窗口`;
}
function formatPlanLabel(plan) {
  if (!plan || typeof plan !== 'string') return null;
  const map = { plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team', enterprise: 'Enterprise', free: 'Free', edu: 'Edu' };
  return map[plan.toLowerCase()] ?? plan;
}
function normalizeCodexWindow(win, id, fallbackLabel) {
  if (!win || typeof win !== 'object') return null;
  const rawUsed = typeof win.usedPercent === 'number' ? win.usedPercent
    : typeof win.used_percent === 'number' ? win.used_percent
    : typeof win.remainingPercent === 'number' ? 100 - win.remainingPercent
    : typeof win.remaining_percent === 'number' ? 100 - win.remaining_percent
    : null;
  if (rawUsed === null || !Number.isFinite(rawUsed)) return null;
  const clampedUsed = Math.max(0, Math.min(100, rawUsed));
  const usedPercentExact = Math.round(clampedUsed * 10000) / 10000;
  const remainingPercentExact = Math.round((100 - clampedUsed) * 10000) / 10000;
  const usedPercent = Math.max(0, Math.min(100, Math.round(clampedUsed * 10) / 10));
  const remainingPercent = Math.max(0, Math.min(100, Math.round((100 - usedPercent) * 10) / 10));
  const windowMinutes = Number(win.windowDurationMins ?? win.window_duration_mins ?? win.windowMinutes) || null;
  const resetsAt = parseEpochMs(win.resetsAt ?? win.resets_at ?? win.resetTime);
  return {
    id,
    label: formatWindowMinutes(windowMinutes, fallbackLabel),
    usedPercent,
    remainingPercent,
    usedPercentExact,
    remainingPercentExact,
    ...(windowMinutes ? { windowMinutes } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}
export function normalizeCodexQuota(raw, acct = null) {
  const root = raw?.rateLimits ?? raw ?? {};
  const byId = raw?.rateLimitsByLimitId && typeof raw.rateLimitsByLimitId === 'object' ? raw.rateLimitsByLimitId : null;
  const groups = [];
  const pushEntry = (id, name, entry) => {
    if (!entry || typeof entry !== 'object') return;
    const windows = [];
    const primary = normalizeCodexWindow(entry.primary, `${id}:primary`, '5 小时窗口');
    const secondary = normalizeCodexWindow(entry.secondary, `${id}:secondary`, '7 天窗口');
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    if (!windows.length) {
      const direct = normalizeCodexWindow(entry, `${id}:main`, '周期窗口');
      if (direct) windows.push(direct);
    }
    if (windows.length) groups.push({ id, name, windows });
  };
  if (byId && Object.keys(byId).length) {
    for (const [limitId, entry] of Object.entries(byId)) {
      const label = entry?.limitName || (limitId === 'codex' ? 'Codex 通用额度' : limitId);
      pushEntry(limitId, label, entry);
    }
  }
  if (!groups.length) {
    const limitId = root.limitId || 'codex';
    const label = root.limitName || 'Codex 通用额度';
    pushEntry(limitId, label, root);
  }
  const plan = formatPlanLabel(raw?.planType ?? root?.planType ?? acct?.planType ?? acct?.account?.planType);
  const rawCredits = raw?.credits ?? root?.credits ?? null;
  const credits = rawCredits && typeof rawCredits === 'object' && (rawCredits.hasCredits || rawCredits.unlimited || rawCredits.balance != null)
    ? {
        hasCredits: Boolean(rawCredits.hasCredits),
        unlimited: Boolean(rawCredits.unlimited),
        ...(rawCredits.balance != null ? { balance: formatCreditBalance(rawCredits.balance) } : {}),
      }
    : null;
  return {
    engine: 'codex',
    label: 'Codex',
    status: groups.length || credits ? 'ok' : 'unavailable',
    ...(plan ? { plan } : {}),
    ...(credits ? { credits } : {}),
    groups,
    fetchedAt: Date.now(),
  };
}

export class CodexTurns {
  constructor(host, socketPath, cwd, { toolBudget } = {}) {
    this.host = host;
    this.db = host.store;
    this.socketPath = socketPath;
    this.cwd = cwd;
    this.toolBudget = resolveToolBudget(toolBudget);
    this.active = new Map();
    this.modelCache = null;
    this.modelCacheAt = 0;
    this.modelRefresh = null;
    this.lastRateLimits = null;
  }

  turn(id) { return this.db.get('turns', id); }
  save(id, changes) { this.db.put('turns', id, { ...this.turn(id), ...changes }); }
  event(t, event) { this.db.append(t.sessionId, { ...event, engine: 'codex' }); this.host.emit('events', t.sessionId); }
  broker(t, method, args) { return this.host.broker(this.host.workspace(t.workspaceId), method, args); }
  emitNoticeOnce(t, guard, notice) {
    if (!notice || !guard?.markNoticeEmitted(notice.code)) return;
    this.event(t, { type: 'turn_notice', ...notice });
  }
  listTurnCallsWithLegacy(t) {
    const dbCalls = this.db.listTurnCalls(t.id);
    if (!t.calls?.length) return dbCalls;
    const seen = new Set(dbCalls.map(c => c.callId));
    const legacy = t.calls
      .filter(c => c?.id && !seen.has(c.id))
      .map((c, idx) => ({
        turnId: t.id,
        sessionId: t.sessionId,
        seq: dbCalls.length + idx + 1,
        callId: c.id,
        tool: c.tool,
        effectiveTool: c.tool,
        inputHash: c.inputHash ?? '',
        argsSummary: c.args ?? {},
        operationId: null,
        state: 'pending',
        ok: null,
        consumed: false,
        counted: true,
        legacy: true,
      }));
    return [...dbCalls, ...legacy];
  }

  refreshModels() {
    if (this.modelRefresh) return this.modelRefresh;
    this.modelRefresh = (async () => {
      let socket, app;
      try {
        socket = createConnection(this.socketPath);
        await Promise.race([once(socket, 'connect'), delay(4000).then(() => { throw Error('TIMEOUT'); })]);
        app = new CodexAppServer({ experimentalApi: true, initializeTimeoutMs: 6000, transport: { input: socket, output: socket } });
        const res = await Promise.race([app.call('model/list', {}), delay(6000).then(() => { throw Error('TIMEOUT'); })]);
        const items = Array.isArray(res?.data ?? res?.models) ? (res.data ?? res.models) : [];
        const models = items.map(m => ({
          id: m.id ?? m.model,
          name: m.displayName ?? m.name ?? m.id ?? m.model,
          efforts: Array.isArray(m.supportedReasoningEfforts)
            ? m.supportedReasoningEfforts.map(e => (typeof e === 'string' ? e : e.reasoningEffort)).filter(Boolean)
            : ['low', 'medium', 'high'],
          defaultEffort: m.defaultReasoningEffort ?? 'medium',
          isDefault: Boolean(m.isDefault),
        })).filter(m => m.id);
        if (models.length) {
          this.modelCache = { models };
          this.modelCacheAt = Date.now();
          return this.modelCache;
        }
      } catch {}
      finally {
        try { app?.stop(); } catch {}
        try { socket?.destroy(); } catch {}
        this.modelRefresh = null;
      }
      return this.modelCache ?? DEFAULT_MODELS;
    })();
    return this.modelRefresh;
  }

  async listModels() {
    if (this.modelCache && Date.now() - this.modelCacheAt < 30 * 60 * 1000) return this.modelCache;
    const pending = this.refreshModels();
    if (this.modelCache) return this.modelCache;
    return Promise.race([pending, delay(1500).then(() => this.modelCache ?? DEFAULT_MODELS)]);
  }

  async readQuota() {
    let socket, app;
    const ac = new AbortController();
    const timeout = ms => delay(ms, undefined, { signal: ac.signal }).then(() => { throw Error('TIMEOUT'); });
    try {
      socket = createConnection(this.socketPath);
      await Promise.race([once(socket, 'connect'), timeout(4000)]);
      app = new CodexAppServer({ experimentalApi: true, initializeTimeoutMs: 6000, transport: { input: socket, output: socket } });
      const [limits, acct] = await Promise.all([
        Promise.race([app.call('account/rateLimits/read', {}), timeout(8000)]),
        Promise.race([app.call('account/read', {}), timeout(4000)]).catch(() => null),
      ]);
      const parsed = normalizeCodexQuota(limits, acct);
      if (parsed.status === 'ok') this.lastRateLimits = parsed;
      return parsed;
    } catch (error) {
      if (this.lastRateLimits && Date.now() - this.lastRateLimits.fetchedAt < 10 * 60 * 1000) {
        return this.lastRateLimits;
      }
      const msg = String(error?.message || 'QUOTA_UNAVAILABLE');
      return {
        engine: 'codex',
        label: 'Codex',
        status: 'error',
        error: /TIMEOUT/i.test(msg) ? '查询 Codex 额度超时，请稍后重试。'
          : /auth|login/i.test(msg) ? 'Codex 尚未登录，请在服务器登录 Codex CLI。'
          : '暂时无法获取 Codex 额度信息。',
        groups: [],
        fetchedAt: Date.now(),
      };
    } finally {
      ac.abort();
      try { app?.stop(); } catch {}
      try { socket?.destroy(); } catch {}
    }
  }

  async workspaceTools(t) {
    const remote = await this.broker(t, 'workspace');
    assertIdentity(remote.grant, t.binding);
    if (!remote.confirmed || remote.grant.grantVersion !== t.binding.grantVersion || remote.grant.revoked) throw Error('LOCAL_PERMISSION_CHANGED');
    const tools = listTools(remote.grant, true, remote.sandbox?.supportedTools, remote.sandbox).filter(tool => workspaceNames.has(tool.name));
    const sessionAtts = this.db.attachments(t.sessionId);
    if (sessionAtts.length) {
      tools.push(SESSION_TOOLS[0]);
      if (tools.some(x => x.name === 'workspace_write_file')) tools.push(SESSION_TOOLS[1]);
    }
    tools.push(...MEMORY_TOOLS);
    tools.sandbox = remote.sandbox;
    return tools;
  }

  async handleSessionReadAttachment(t, args) {
    const query = String(args?.attachment ?? '').trim();
    const list = this.db.attachments(t.sessionId);
    const match = list.find(a => a.id === query || a.name === query);
    if (!match) return failure(`Attachment not found: ${query}`);
    const { att, bytes } = await this.host.readAttachmentBytes(t.sessionId, match.id);
    if (IMAGE_MIMES.has(att.mime)) {
      if (bytes.length > 5 * 1024 * 1024) return failure('Image attachment is too large to inspect inline.');
      return { success: true, contentItems: [{ type: 'inputImage', imageUrl: `data:${att.mime};base64,${bytes.toString('base64')}` }, { type: 'inputText', text: `Image attachment ${att.name} (${att.mime}, ${bytes.length} bytes)` }] };
    }
    let body;
    if (extname(att.name).toLowerCase() === '.pdf' || att.mime === 'application/pdf') {
      try { body = await extractPdfText(this.host.attachmentPath(t.sessionId, att.id).path); }
      catch { return failure('Unable to extract text from PDF attachment.'); }
    } else {
      if (bytes.subarray(0, 8192).includes(0)) return failure(`Binary attachment (${bytes.length} bytes) cannot be read as text.`);
      body = bytes.toString('utf8');
    }
    const lines = body.replace(/\r\n/g, '\n').split('\n');
    const start = Math.max(1, Number(args.offset ?? 1));
    const len = Math.min(500, Math.max(1, Number(args.length ?? 200)));
    const slice = lines.slice(start - 1, start - 1 + len).map((l, idx) => `${start + idx}\t${l}`).join('\n');
    const more = start - 1 + len < lines.length ? `\n… (${lines.length} total lines)` : '';
    return { success: true, contentItems: [{ type: 'inputText', text: (slice || '(empty)') + more }] };
  }

  async waitForWorkspaceReady(t, run, waitMs = 20000) {
    const deadline = Date.now() + waitMs;
    while (!run.ending && !this.turn(t.id)?.cancelRequested) {
      try {
        const info = await this.broker(t, 'workspace');
        if (info.confirmed && info.phase === 'ready') return info;
      } catch {}
      if (Date.now() >= deadline) return null;
      await delay(500);
    }
    return null;
  }

  async call(t, run, method, params) {
    run.touch?.();
    if (method !== 'item/tool/call') throw Error('UNSUPPORTED_CODEX_REQUEST');
    const realTurnId = await run.ready.promise;
    if (!realTurnId || params.threadId !== run.threadId || params.turnId !== realTurnId || params.namespace) throw Error('TOOL_CALL_OUT_OF_SCOPE');
    const current = this.turn(t.id), session = this.host.session(t.sessionId);
    if (session.activeTurnId !== t.id || session.codexThreadId !== run.threadId || current.cancelRequested || run.ending) return failure('Turn stopped.');
    let { tool, callId, arguments: args } = params;
    string(callId);
    if (!run.tools.has(tool)) return failure('Tool unavailable on this device.');
    if (tool === 'session_read_attachment') {
      const localVerdict = run.guard.checkLocal();
      if (!localVerdict.allowed) {
        this.emitNoticeOnce(t, run.guard, localVerdict.notice);
        return failure(localVerdict.modelMessage);
      }
      run.guard.recordLocal();
      this.event(t, { type: 'tool_call', id: callId, name: tool, input: boundEventInput(args), status: 'running' });
      const res = await this.handleSessionReadAttachment(current, args);
      const out = res.contentItems.filter(x => x.type === 'inputText').map(x => x.text).join('\n');
      this.event(t, { type: 'tool_call', id: callId, name: tool, input: boundEventInput(args), status: res.success ? 'completed' : 'failed', output: out.slice(0, 4500) });
      return res;
    }
    if (MEMORY_TOOL_NAMES.has(tool)) {
      const localVerdict = run.guard.checkLocal();
      if (!localVerdict.allowed) {
        this.emitNoticeOnce(t, run.guard, localVerdict.notice);
        return failure(localVerdict.modelMessage);
      }
      run.guard.recordLocal();
      this.event(t, { type: 'tool_call', id: callId, name: tool, input: boundEventInput(args), status: 'running' });
      const res = executeMemoryTool(this.db, t.workspaceId, tool, args);
      this.event(t, { type: 'tool_call', id: callId, name: tool, input: boundEventInput(args), status: res.ok ? 'completed' : 'failed', output: res.text.slice(0, 4500) });
      return { success: res.ok, contentItems: [{ type: 'inputText', text: res.text }] };
    }
    let effectiveTool = tool, effectiveArgs = args;
    if (tool === 'session_send_attachment') {
      const query = String(args?.attachment ?? '').trim();
      const match = this.db.attachments(t.sessionId).find(a => a.id === query || a.name === query);
      if (!match) return failure(`Attachment not found: ${query}`);
      const { bytes } = await this.host.readAttachmentBytes(t.sessionId, match.id);
      if (bytes.includes(0) || bytes.length > 131072) return failure('Only UTF-8 text attachments up to 128 KiB can be copied via session_send_attachment.');
      effectiveTool = 'workspace_write_file';
      effectiveArgs = { path: args.path, content: bytes.toString('utf8'), mode: 'rewrite', expectedRevision: args.expectedRevision };
    }
    try { normalize(effectiveTool, effectiveArgs); }
    catch { return failure(effectiveTool === 'workspace_read_file' ? 'Invalid arguments. Use a relative path, integer line offset, and 1 to 500 lines.' : 'Invalid arguments. Follow the advertised schema.'); }
    const inputHash = hash({ tool: effectiveTool, args: effectiveArgs });
    const existingDb = this.db.getTurnCall(t.id, callId);
    const legacyPrev = !existingDb ? current.calls?.find(call => call.id === callId) : null;
    const previous = existingDb ?? (legacyPrev ? { callId: legacyPrev.id, inputHash: legacyPrev.inputHash, counted: true } : null);
    if (previous && previous.inputHash !== inputHash) return failure('Conflicting tool call.');
    if (!previous?.counted) {
      const verdict = run.guard.checkWorkspace(effectiveTool, inputHash);
      if (!verdict.allowed) {
        this.emitNoticeOnce(t, run.guard, verdict.notice);
        return failure(verdict.modelMessage);
      }
    }
    const eventInput = boundEventInput(args);
    if (!previous) {
      this.db.tx(() => {
        this.db.upsertTurnCall({
          turnId: t.id,
          sessionId: t.sessionId,
          callId,
          tool,
          effectiveTool,
          inputHash,
          argsSummary: summarizeCallArgs(args),
          state: 'pending',
          counted: false,
        });
        this.db.append(t.sessionId, { type: 'tool_call', id: callId, name: tool, input: eventInput, status: 'running', engine: 'codex' });
      });
      this.host.emit('events', t.sessionId);
    }
    const abortPreDispatch = (message, uiOutput = message) => {
      if (!previous?.counted) {
        this.db.tx(() => {
          this.db.updateTurnCall(t.id, callId, { state: 'aborted', ok: false, consumed: true, counted: false });
          this.db.append(t.sessionId, { type: 'tool_call', id: callId, name: tool, input: eventInput, status: 'failed', output: uiOutput, engine: 'codex' });
        });
        this.host.emit('events', t.sessionId);
      }
      return failure(message);
    };
    const h = await this.host.host(current);
    // Check live authorization again before issuing or returning a previously stored result.
    if (run.ending || this.turn(t.id).cancelRequested) return abortPreDispatch('Turn stopped.', '已停止。');
    const waitAlive = setInterval(() => run.touch?.(), 15000);
    waitAlive.unref?.();
    return this.host.withWorkspaceLock(t.workspaceId, async () => {
      clearInterval(waitAlive);
      if (run.ending || this.turn(t.id).cancelRequested) return abortPreDispatch('Turn stopped.', '已停止。');
      await this.waitForWorkspaceReady(current, run, 20000);
      run.touch?.();
      let allowedTools;
      try { allowedTools = await this.workspaceTools(current); }
      catch (err) {
        return abortPreDispatch(err?.message === 'LOCAL_PERMISSION_CHANGED' ? 'Workspace permission changed.' : 'Workspace unavailable.');
      }
      if (!allowedTools.some(item => item.name === effectiveTool)) {
        return abortPreDispatch('Workspace permission changed.');
      }
      let ticket;
      try {
        ticket = await h.executor.issue(callId, effectiveTool, effectiveArgs);
      } catch (err) {
        if (!run.ending && !this.turn(t.id)?.cancelRequested) {
          const outcome = run.guard.recordWorkspaceOutcome(effectiveTool, inputHash, false);
          if (outcome.circuitTrippedNow) this.emitNoticeOnce(t, run.guard, outcome.notice);
        }
        throw err;
      }
      const alreadyCounted = Boolean(this.db.getTurnCall(t.id, callId)?.counted || legacyPrev);
      this.db.tx(() => {
        this.db.updateTurnCall(t.id, callId, { operationId: ticket.operationId, state: 'dispatched', counted: true });
        this.save(t.id, { operationId: ticket.operationId });
      });
      if (!alreadyCounted) run.guard.recordWorkspaceDispatched(effectiveTool);
      const saved = this.db.get('codexResults', ticket.operationId);
      if (saved) {
        await h.executor.consumeAfterPersist(saved.receipt);
        this.db.updateTurnCall(t.id, callId, {
          operationId: ticket.operationId,
          state: saved.reply?.success === false ? 'failed' : 'completed',
          ok: saved.reply?.success !== false,
          consumed: true,
          counted: true,
        });
        return appendCodexWarning(saved.reply, run.guard.softWarning(effectiveTool));
      }
      if (run.ending || this.turn(t.id).cancelRequested) {
        await this.broker(current, 'stopTurn', turnScope(current));
        return failure('Turn stopped.');
      }
      try {
        let result = await h.client.callTool({ name: effectiveTool, arguments: effectiveArgs, _meta: { 'anywhere/callTicket': ticket.ticket } });
        const until = Date.now() + 180000;
        let outputSeq = 0;
        let notReceivedCancelSent = false;
        while (result.structuredContent?.task && !result.structuredContent.task.resultReady) {
          run.touch?.();
          const taskState = result.structuredContent.task.state;
          if (run.ending || taskState === 'unknown' || Date.now() > until) throw Error('WORKSPACE_RESULT_PENDING');
          if (taskState === 'not_received' && !notReceivedCancelSent) {
            notReceivedCancelSent = true;
            result = await h.client.callTool({ name: 'workspace_task_cancel', arguments: { operationId: ticket.operationId } });
            if (result.structuredContent?.task?.resultReady) break;
          }
          const receivedSeq = result.structuredContent.task.receivedSeq ?? 0;
          if (receivedSeq > outputSeq) {
            try {
              const out = await h.executor.output(ticket.operationId, outputSeq);
              const chunk = out.rows.map(r => r.data).join('');
              if (chunk) this.host.delta(t.sessionId, { kind: 'tool_output', id: callId, text: chunk });
              outputSeq = out.nextSeq;
            } catch {}
          }
          await delay(60);
          result = await h.client.callTool({ name: 'workspace_task_status', arguments: { operationId: ticket.operationId } });
        }
        return await this.capture(current, { id: callId, tool, effectiveTool, args, inputHash }, h, ticket.operationId, result, { guard: run.guard });
      } catch (err) {
        if (!run.ending && !this.turn(t.id)?.cancelRequested) {
          const outcome = run.guard.recordWorkspaceOutcome(effectiveTool, inputHash, false);
          if (outcome.circuitTrippedNow) this.emitNoticeOnce(t, run.guard, outcome.notice);
        }
        throw err;
      }
    }).finally(() => clearInterval(waitAlive));
  }

  async capture(t, call, h, operationId, result, { guard } = {}) {
    const data = result.structuredContent, task = data?.task;
    if (!task?.resultReady || task.operationId !== operationId || data.workspaceId !== t.workspaceId) throw Error('WORKSPACE_RESULT_PENDING');
    const items = result.content ?? data.result?.response?.content ?? [];
    const text = items.filter(x => x.type === 'text').map(x => x.text).join('\n');
    const ok = !result.isError && task.state === 'succeeded';
    const contentItems = [];
    for (const item of items) {
      if (item.type === 'image' && item.data && item.mimeType) {
        contentItems.push({ type: 'inputImage', imageUrl: `data:${item.mimeType};base64,${item.data}` });
      }
    }
    contentItems.push({ type: 'inputText', text: text || task.state });
    const reply = { success: ok, contentItems };
    const receipt = { operationId, resultDigest: task.resultDigest, receiptId: 'codex:' + operationId };
    const eventInput = boundEventInput(call.args);
    this.db.tx(() => {
      if (!this.db.get('codexResults', operationId)) {
        this.db.put('codexResults', operationId, { receipt, reply, task, callId: call.id, fileVersions: data.result?.fileVersions });
        for (const version of data.result?.fileVersions ?? []) {
          this.db.put('revisions', hash({ sessionId: t.sessionId, workspaceId: t.workspaceId, path: version.path }), version);
        }
        this.db.append(t.sessionId, { type: 'tool_call', id: call.id, name: call.tool, input: eventInput, status: ok ? 'completed' : 'failed', output: text.slice(0, 8000), engine: 'codex' });
      }
      this.db.updateTurnCall(t.id, call.id, { operationId, state: ok ? 'completed' : 'failed', ok, counted: true });
    });
    this.host.emit('events', t.sessionId);
    await h.executor.consumeAfterPersist(receipt);
    this.db.updateTurnCall(t.id, call.id, { consumed: true });
    if (guard) {
      const effectiveTool = call.effectiveTool ?? call.tool;
      const outcome = guard.recordWorkspaceOutcome(effectiveTool, call.inputHash ?? '', ok);
      if (outcome.circuitTrippedNow) this.emitNoticeOnce(t, guard, outcome.notice);
      return appendCodexWarning(reply, guard.softWarning(effectiveTool));
    }
    return reply;
  }

  // Codex attaches dynamic tools at thread/start. Resume an unchanged tool set; on a
  // permission change, carry this same bound conversation into a thread with the new tools.
  async restoreConversation(app, threadId, t) {
    const before = t.historyBefore ?? 0;
    let cursor = 0;
    while (cursor < before) {
      const page = this.db.page(t.sessionId, cursor);
      if (!page.events.length) throw Error('SESSION_HISTORY_INCOMPLETE');
      const items = [];
      for (const { seq, event } of page.events) {
        if (seq > before) break;
        if (event.type === 'user_message' || event.type === 'assistant_text') {
          const user = event.type === 'user_message';
          items.push({ type: 'message', role: user ? 'user' : 'assistant', content: [{ type: user ? 'input_text' : 'output_text', text: event.text }] });
        } else if (event.type === 'tool_call' && ['completed', 'failed'].includes(event.status)) {
          items.push({ type: 'function_call', call_id: event.id, name: event.name, arguments: JSON.stringify(event.input ?? {}) },
            { type: 'function_call_output', call_id: event.id, output: event.output || event.status });
        }
      }
      if (items.length) await app.call('thread/inject_items', { threadId, items });
      cursor = page.throughSeq;
    }
  }

  async run(t) {
    const startedAt = Date.now();
    const socket = createConnection(this.socketPath);
    const connected = once(socket, 'connect');
    socket.on('error', () => {});
    const run = { socket, ready: Promise.withResolvers(), end: Promise.withResolvers(), queue: Promise.resolve(), messages: [], thoughts: [], usage: null, context: null, model: null, tools: new Set(), guard: new TurnToolGuard(this.toolBudget, this.db.listTurnCalls(t.id)) };
    run.end.promise.catch(() => {});
    this.active.set(t.id, run);
    const initialModel = (() => { try { return this.host.session(t.sessionId)?.options?.model ?? null; } catch { return null; } })();
    this.host?.emit?.('turn_start', { turnId: t.id, sessionId: t.sessionId, engine: 'codex', model: initialModel, startedAt });
    const app = new CodexAppServer({
      experimentalApi: true, initializeTimeoutMs: 85000, transport: { input: socket, output: socket },
      onExit: () => run.end.reject(Error('CODEX_DISCONNECTED')),
      onRequest: (method, params) => {
        const work = run.queue.then(() => this.call(t, run, method, params));
        run.queue = work.catch(() => {});
        return work.catch(e => failure(e.message));
      },
    });
    run.app = app;
    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => run.end.reject(Error('CODEX_TURN_TIMEOUT')), 240000);
    };
    run.touch = resetIdle;
    resetIdle();
    const maxTimer = setTimeout(() => run.end.reject(Error('CODEX_TURN_TIMEOUT')), 1800000);
    app.onNotification((method, p) => {
      if (p.threadId !== run.threadId || !p.threadId) return;
      resetIdle();
      if (method === 'item/agentMessage/delta' && typeof p.delta === 'string' && p.delta) {
        this.host.delta(t.sessionId, { kind: 'text', id: p.itemId ?? t.id, text: p.delta });
      }
      if ((method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') && typeof p.delta === 'string' && p.delta) {
        this.host.delta(t.sessionId, { kind: 'thinking', id: p.itemId ?? t.id, text: p.delta });
      }
      if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.last) {
        run.usage = p.tokenUsage.last;
        const used = typeof p.tokenUsage.last.totalTokens === 'number'
          ? p.tokenUsage.last.totalTokens
          : ((p.tokenUsage.last.inputTokens ?? 0) + (p.tokenUsage.last.outputTokens ?? 0));
        const window = typeof p.tokenUsage.modelContextWindow === 'number' && p.tokenUsage.modelContextWindow > 0
          ? p.tokenUsage.modelContextWindow
          : (run.context?.window ?? null);
        if (typeof used === 'number' && Number.isFinite(used)) {
          run.context = { used, ...(window ? { window } : {}) };
          this.host.delta(t.sessionId, { kind: 'context', used, window: window ?? undefined });
        }
      }
      if (method === 'account/rateLimits/updated' && p.rateLimits) {
        const parsed = normalizeCodexQuota({ rateLimits: p.rateLimits });
        if (parsed.status === 'ok') {
          this.lastRateLimits = parsed;
          this.host?.emit?.('quota_update', parsed);
        }
      }
      if (method === 'item/completed' && p.item?.type === 'reasoning') {
        const text = Array.isArray(p.item.summary) ? p.item.summary.map(s => (typeof s === 'string' ? s : s.text ?? '')).join('\n').trim() :
          typeof p.item.text === 'string' ? p.item.text.trim() : '';
        if (text) run.thoughts.push({ turnId: p.turnId, id: p.item.id, text: text.slice(0, 6000) });
      }
      if (method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase !== 'commentary') {
        run.messages.push({ turnId: p.turnId, id: p.item.id, text: p.item.text });
      }
      if (method === 'turn/completed') run.end.resolve(p.turn);
    });
    let outcome = 'interrupted';
    try {
      const [tools] = await Promise.all([this.workspaceTools(t), connected]);
      run.tools = new Set(tools.map(tool => tool.name));
      const session = this.host.session(t.sessionId), saved = session.codexThreadId;
      const opts = session.options ?? {};
      const signature = JSON.stringify(tools.map(tool => tool.name).sort());
      const resume = saved && session.codexToolSet === signature;
      const hasAtts = this.db.attachments(t.sessionId).length > 0;
      const projectDocs = (!resume && tools.some(tool => tool.name === 'workspace_read_files'))
        ? await this.host.preloadProjectDocs(t)
        : [];
      const projectLabel = this.host.workspaces.get(t.workspaceId)?.label ?? '';
      const memoryInstructions = buildMemoryInstructions({
        store: this.db,
        workspaceId: t.workspaceId,
        projectLabel,
        projectDocs,
      });
      const browserHint = browserInstructions(tools.sandbox);
      const common = {
        cwd: this.cwd, sandbox: 'read-only', approvalPolicy: 'never',
        ...(opts.model ? { model: opts.model } : {}),
        developerInstructions: [deviceInstructions(hasAtts), browserHint, memoryInstructions].filter(Boolean).join('\n\n'),
        config: { web_search: 'disabled' },
      };
      if (this.turn(t.id).cancelRequested) throw Error('TURN_STOPPED');
      const thread = resume ? await app.call('thread/resume', { ...common, threadId: saved, excludeTurns: true }) :
        await app.call('thread/start', {
          ...common, environments: [], selectedCapabilityRoots: [], ephemeral: false,
          dynamicTools: tools.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema, deferLoading: false })),
        });
      if (resume && thread.thread.id !== saved) throw Error('SESSION_TARGET_MISMATCH');
      run.threadId = thread.thread.id;
      run.model = opts.model ?? thread.model ?? null;
      if (saved && !resume) await this.restoreConversation(app, run.threadId, t);
      this.db.tx(() => {
        const s = this.host.session(t.sessionId);
        if (s.activeTurnId !== t.id || s.codexThreadId !== saved) throw Error('SESSION_TARGET_MISMATCH');
        this.db.put('sessions', s.id, { ...s, codexThreadId: run.threadId, codexToolSet: signature });
        this.save(t.id, { threadId: run.threadId, model: run.model, state: 'running' });
      });
      if (this.turn(t.id).cancelRequested) throw Error('TURN_STOPPED');
      const atts = t.attachments ?? [];
      const images = atts.filter(a => IMAGE_MIMES.has(a.mime) && a.size <= 10 * 1024 * 1024);
      const promptText = describeAttachments(t.text, atts);
      const turnInput = [
        { type: 'text', text: promptText },
        ...images.map(a => ({ type: 'localImage', path: a.path })),
      ];
      const { turn } = await app.call('turn/start', {
        threadId: run.threadId, environments: [],
        effort: opts.effort ?? 'medium',
        ...(opts.model ? { model: opts.model } : {}),
        input: turnInput,
      });
      run.turnId = turn.id;
      this.save(t.id, { modelTurnId: turn.id, binding: { ...t.binding, turnId: turn.id } });
      run.ready.resolve(turn.id);
      if (this.turn(t.id).cancelRequested) await this.interrupt(t.id);
      const ended = await run.end.promise;
      if (ended.id !== turn.id || ended.status !== 'completed') throw Error('CODEX_TURN_INCOMPLETE');
      await run.queue;
      if (this.turn(t.id).cancelRequested) throw Error('TURN_STOPPED');
      const messages = run.messages.filter(m => m.turnId === turn.id && typeof m.text === 'string' && m.text.length);
      if (!messages.length) throw Error('CODEX_EMPTY_RESPONSE');
      const thoughts = run.thoughts.filter(m => m.turnId === turn.id && m.text);
      const durationMs = ended.durationMs ?? (Date.now() - startedAt);
      const usage = run.usage ? { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, cachedInputTokens: run.usage.cachedInputTokens } : undefined;
      this.db.tx(() => {
        for (const th of thoughts) {
          this.db.append(t.sessionId, { type: 'thinking', id: th.id, text: th.text, engine: 'codex' });
        }
        for (const m of messages) {
          for (let pos = 0; pos < m.text.length; pos += 16000) {
            this.db.append(t.sessionId, { type: 'assistant_text', id: m.id + '-' + pos, text: m.text.slice(pos, pos + 16000), engine: 'codex' });
          }
        }
        this.save(t.id, { modelFinished: true, durationMs, usage, ...(run.context ? { context: run.context } : {}), model: run.model });
      });
      outcome = 'succeeded';
    } catch (error) {
      const usage = run.usage ? { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, cachedInputTokens: run.usage.cachedInputTokens } : undefined;
      this.save(t.id, {
        error: String(error.message).slice(0, 280),
        durationMs: Date.now() - startedAt,
        ...(usage ? { usage } : {}),
        ...(run.context ? { context: run.context } : {}),
        ...(run.model ? { model: run.model } : {}),
      });
      if (this.turn(t.id).cancelRequested) outcome = 'cancelled';
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      run.ending = true;
      run.ready.resolve(null);
      app.stop(); socket.destroy();
      await run.queue;
      this.save(t.id, { modelOutcome: outcome });
      try { await this.reconcile(this.turn(t.id)); }
      finally { this.active.delete(t.id); }
    }
  }

  async interrupt(id) {
    const run = this.active.get(id), t = this.turn(id);
    if (run?.turnId) {
      // interrupt can race turn/completed. The persisted cancel flag governs final status.
      await run.app.call('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
    }
    if (t?.modelTurnId && (this.db.hasTurnCalls(id) || t.calls?.length)) {
      await this.broker(t, 'stopTurn', turnScope(t)).catch(() => {});
    }
  }

  // On restart reconcile original call IDs only. Never resubmit the user's model turn.
  async reconcile(t) {
    if (t.consumed) return;
    const allCalls = this.listTurnCallsWithLegacy(t);
    const pendingCalls = allCalls.filter(call => !call.consumed);
    let hasOperation = allCalls.some(call => Boolean(call.operationId));
    const opIds = new Set(allCalls.map(call => call.operationId).filter(Boolean));
    if (pendingCalls.length) {
      const h = await this.host.host(t);
      for (const call of pendingCalls) {
        const found = await h.executor.recover(call.callId);
        if (!found) {
          this.db.tx(() => {
            if (!this.db.get('codexUnsubmitted', t.id + ':' + call.callId)) {
              this.db.append(t.sessionId, { type: 'tool_call', id: call.callId, name: call.tool, input: boundEventInput(call.argsSummary), status: 'failed', output: '未提交到设备。', engine: 'codex' });
              this.db.put('codexUnsubmitted', t.id + ':' + call.callId, true);
            }
            if (!call.legacy) this.db.updateTurnCall(t.id, call.callId, { state: 'unsubmitted', ok: false, consumed: true, counted: false });
          });
          continue;
        }
        hasOperation = true;
        const opId = found.operationId;
        opIds.add(opId);
        const saved = this.db.get('codexResults', opId);
        if (saved) {
          await h.executor.consumeAfterPersist(saved.receipt);
          if (!call.legacy) {
            this.db.updateTurnCall(t.id, call.callId, {
              operationId: opId,
              state: saved.reply?.success === false ? 'failed' : 'completed',
              ok: saved.reply?.success !== false,
              consumed: true,
              counted: true,
            });
          }
          continue;
        }
        const result = await h.executor.status(opId);
        if (!result.structuredContent.task.resultReady) {
          await this.broker(t, 'stopTurn', turnScope(t));
          this.save(t.id, { state: result.structuredContent.task.state });
          return;
        }
        await this.capture(t, { id: call.callId, tool: call.tool, effectiveTool: call.effectiveTool, args: call.argsSummary, inputHash: call.inputHash }, h, opId, result);
      }
    }
    if (hasOperation) await this.broker(t, 'reasoningIdle', turnScope(t));
    const latest = this.turn(t.id);
    const state = latest.cancelRequested ? 'cancelled' : latest.modelFinished ? 'succeeded' : 'interrupted';
    const finalCalls = this.listTurnCallsWithLegacy(latest);
    const countedCalls = finalCalls.filter(c => c.counted);
    const toolCalls = countedCalls.length
      ? { total: countedCalls.length, mutations: countedCalls.filter(c => isMutationTool(c.effectiveTool ?? c.tool)).length }
      : null;
    let finalized = false;
    this.db.tx(() => {
      if (this.turn(t.id).consumed) return;
      finalized = true;
      const label = state === 'cancelled' ? '已停止生成。' : 'Codex 回合中断，请查看工具记录后重新发送。';
      this.db.append(t.sessionId, {
        type: 'turn_end', turnId: t.id, ok: state === 'succeeded', engine: 'codex',
        ...(state === 'succeeded' ? {} : { error: label }),
        ...(latest.durationMs ? { durationMs: latest.durationMs } : {}),
        ...(latest.model ? { model: latest.model } : {}),
        ...(latest.usage ? { usage: latest.usage } : {}),
        ...(latest.context ? { context: latest.context } : {}),
        ...(toolCalls ? { toolCalls } : {}),
      });
      this.save(t.id, { state, done: true, consumed: true });
      for (const opId of opIds) this.db.deleteRecord('codexResults', opId);
      for (const call of finalCalls) {
        if (call.operationId) this.db.deleteRecord('codexResults', call.operationId);
        this.db.deleteRecord('codexUnsubmitted', t.id + ':' + call.callId);
      }
      const s = this.host.session(t.sessionId);
      const contextUsage = latest.context
        ? { used: latest.context.used, window: latest.context.window ?? s.contextUsage?.window ?? null, engine: 'codex', model: latest.model ?? s.contextUsage?.model ?? null, updatedAt: Date.now() }
        : s.contextUsage;
      const nextSession = { ...s, ...(s.activeTurnId === t.id ? { activeTurnId: null } : {}), ...(contextUsage ? { contextUsage } : {}) };
      if (s.activeTurnId === t.id || latest.context) this.db.put('sessions', s.id, nextSession);
    });
    if (finalized) {
      this.host?.emit?.('turn_end', {
        turnId: t.id,
        sessionId: t.sessionId,
        engine: 'codex',
        model: latest.model ?? null,
        ok: state === 'succeeded',
        usage: latest.usage ?? null,
        toolCalls,
        durationMs: latest.durationMs ?? 0,
        ts: Date.now(),
      });
    }
    await this.host.closeHost(t.id);
    this.host.emit('events', t.sessionId);
    this.host.emit('state');
  }

  async compact(session) {
    if (!session?.codexThreadId) throw Error('NOTHING_TO_COMPACT');
    const socket = createConnection(this.socketPath);
    const connected = once(socket, 'connect');
    socket.on('error', () => {});
    const end = Promise.withResolvers();
    end.promise.catch(() => {});
    let app = null;
    let afterContext = null;
    let compacted = false;
    const timeout = setTimeout(() => end.reject(Error('COMPACT_TIMEOUT')), 120000);
    try {
      await Promise.race([connected, delay(6000).then(() => { throw Error('CODEX_CONNECT_TIMEOUT'); })]);
      app = new CodexAppServer({
        experimentalApi: true, initializeTimeoutMs: 30000, transport: { input: socket, output: socket },
        onExit: () => end.reject(Error('CODEX_DISCONNECTED')),
      });
      app.onNotification((method, p) => {
        if (p?.threadId && p.threadId !== session.codexThreadId) return;
        if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.last) {
          const used = typeof p.tokenUsage.last.totalTokens === 'number'
            ? p.tokenUsage.last.totalTokens
            : ((p.tokenUsage.last.inputTokens ?? 0) + (p.tokenUsage.last.outputTokens ?? 0));
          const window = typeof p.tokenUsage.modelContextWindow === 'number' && p.tokenUsage.modelContextWindow > 0
            ? p.tokenUsage.modelContextWindow
            : (afterContext?.window ?? session.contextUsage?.window ?? null);
          if (typeof used === 'number' && Number.isFinite(used)) afterContext = { used, ...(window ? { window } : {}) };
        }
        if (method === 'thread/compacted') compacted = true;
        if (method === 'turn/completed') end.resolve(p.turn);
      });
      const opts = session.options ?? {};
      const resumed = await app.call('thread/resume', {
        cwd: this.cwd, sandbox: 'read-only', approvalPolicy: 'never',
        ...(opts.model ? { model: opts.model } : {}),
        threadId: session.codexThreadId, excludeTurns: true,
        config: { web_search: 'disabled' },
      });
      await app.call('thread/compact/start', { threadId: session.codexThreadId });
      const ended = await end.promise;
      if (ended?.status && ended.status !== 'completed') throw Error('COMPACT_FAILED');
      return {
        engine: 'codex',
        model: opts.model ?? resumed?.model ?? session.contextUsage?.model ?? null,
        before: session.contextUsage ?? null,
        after: afterContext,
        compacted: compacted || true,
      };
    } finally {
      clearTimeout(timeout);
      try { app?.stop(); } catch {}
      try { socket.destroy(); } catch {}
    }
  }

  async close() {
    for (const [id, run] of this.active) {
      run.end.reject(Error('HOST_SHUTDOWN'));
      if (run.turnId) await this.interrupt(id);
      run.socket.destroy();
    }
  }
}
function formatCreditBalance(val) {
  if (val == null) return null;
  const num = Number(val);
  if (Number.isFinite(num)) {
    return Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, '');
  }
  return String(val);
}
