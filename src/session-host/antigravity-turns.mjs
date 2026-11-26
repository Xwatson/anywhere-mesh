import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CATALOG, browserInstructions, listTools, normalize } from '../workspace/catalog.mjs';
import { assertIdentity } from '../execution/grants.mjs';
import { hash } from '../execution/protocol.mjs';
import {
  MEMORY_TOOLS,
  MEMORY_TOOL_NAMES,
  buildMemoryInstructions,
  executeMemoryTool,
} from './memory.mjs';
import {
  TurnToolGuard,
  appendAgyWarning,
  boundEventInput,
  isMutationTool,
  resolveToolBudget,
  summarizeCallArgs,
} from './tool-budget.mjs';

const MCP_NAME = 'anywhere_workspace';
const MCP_PREFIX = `mcp_${MCP_NAME}_`;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_MODELS = {
  models: [
    { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', isDefault: true },
    { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  ],
};
const SESSION_TOOLS = [
  {
    name: 'session_read_attachment',
    description: 'Read a file attached by the user in this conversation (text, code, log, or PDF text). Specify attachment ID or filename.',
    inputSchema: {
      type: 'object',
      properties: {
        attachment: { type: 'string', minLength: 1, maxLength: 200 },
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
        attachment: { type: 'string', minLength: 1, maxLength: 200 },
        path: { type: 'string', minLength: 1, maxLength: 512 },
        expectedRevision: { type: ['string', 'null'], pattern: '^file-v1:[a-f0-9]{64}$' },
      },
      required: ['attachment', 'path', 'expectedRevision'],
      additionalProperties: false,
    },
  },
];

function modelParts(slug) {
  const match = String(slug || '').match(/^(.+)-(low|medium|high|xhigh|max)$/);
  return match ? { id: match[1], effort: match[2] } : { id: String(slug || '') };
}

function groupAvailableModels(session) {
  const available = session?.models?.availableModels ?? [];
  const models = new Map();
  for (const item of available) {
    const slug = item.modelId ?? item.id;
    const label = item.name ?? slug;
    if (!slug) continue;
    const { id, effort } = modelParts(slug);
    const name = effort ? label.replace(/\s+\((?:low|medium|high|xhigh|max)\)$/i, '') : label;
    const entry = models.get(id) ?? { id, name, efforts: [], defaultEffort: undefined, isDefault: false };
    if (effort && !entry.efforts.includes(effort)) entry.efforts.push(effort);
    if (session?.models?.currentModelId === slug) {
      entry.isDefault = true;
      if (effort) entry.defaultEffort = effort;
    }
    models.set(id, entry);
  }
  return [...models.values()].map(m => ({
    ...m,
    efforts: EFFORT_ORDER.filter(e => m.efforts.includes(e)),
    defaultEffort: m.defaultEffort ?? (m.efforts.includes('medium') ? 'medium' : m.efforts[0]),
  }));
}

function deviceInstructions(hasAttachments) {
  const att = hasAttachments ? ' Use session_read_attachment/session_send_attachment for non-image attachments.' : '';
  return `The project is on a remote device; this host has no project files. Never call built-in local file/shell tools—only use ${MCP_NAME} (${MCP_PREFIX}*) tools with relative paths.${att}`;
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
function agyGroupLabel(name) {
  const s = String(name ?? '').trim();
  if (!s) return '模型额度';
  if (/^gemini\s*models?$/i.test(s)) return 'Gemini 模型';
  if (/^claude\s*(?:and|\/|&)\s*gpt/i.test(s)) return 'Claude / GPT 模型';
  return s;
}
function agyWindowLabel(bucket) {
  const raw = String(bucket.displayName ?? bucket.window ?? bucket.bucketType ?? bucket.bucketId ?? '').trim();
  const low = raw.toLowerCase();
  if (/5.?hour|five.?hour|short.?term|\b5h\b/.test(low)) return '5 小时窗口';
  if (/week|7.?day/.test(low)) return '7 天窗口';
  if (/daily|24.?hour|\b24h\b|\b1d\b/.test(low)) return '24 小时窗口';
  return raw || '额度窗口';
}
function normalizeAgyBucket(bucket, idx) {
  if (!bucket || typeof bucket !== 'object') return null;
  const resetsAt = parseEpochMs(bucket.resetTime ?? bucket.resetsAt ?? bucket.reset_time);
  let remainingPercent = null;
  if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
    remainingPercent = bucket.remainingFraction <= 1 ? bucket.remainingFraction * 100 : bucket.remainingFraction;
  } else if (typeof bucket.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction)) {
    remainingPercent = bucket.remaining_fraction <= 1 ? bucket.remaining_fraction * 100 : bucket.remaining_fraction;
  } else if (typeof bucket.remainingPercent === 'number' && Number.isFinite(bucket.remainingPercent)) {
    remainingPercent = bucket.remainingPercent;
  } else if (typeof bucket.usedPercent === 'number' && Number.isFinite(bucket.usedPercent)) {
    remainingPercent = 100 - bucket.usedPercent;
  } else if (typeof bucket.usedFraction === 'number' && Number.isFinite(bucket.usedFraction)) {
    remainingPercent = (1 - bucket.usedFraction) * 100;
  } else if (resetsAt) {
    // Proto3 JSON omits 0.0 remainingFraction when a bucket is depleted.
    remainingPercent = 0;
  }
  if (remainingPercent === null) return null;
  const clampedRemaining = Math.max(0, Math.min(100, remainingPercent));
  const remainingPercentExact = Math.round(clampedRemaining * 10000) / 10000;
  const usedPercentExact = Math.round((100 - clampedRemaining) * 10000) / 10000;
  remainingPercent = Math.max(0, Math.min(100, Math.round(clampedRemaining * 10) / 10));
  const usedPercent = Math.max(0, Math.min(100, Math.round((100 - remainingPercent) * 10) / 10));
  return {
    id: String(bucket.id ?? bucket.bucketId ?? bucket.bucketType ?? bucket.window ?? idx),
    label: agyWindowLabel(bucket),
    usedPercent,
    remainingPercent,
    usedPercentExact,
    remainingPercentExact,
    ...(resetsAt ? { resetsAt } : {}),
  };
}
function agyWindowRank(w) {
  const key = `${w.id} ${w.label}`.toLowerCase();
  if (/5h|5.?小时|five|short/.test(key)) return 0;
  if (/24h|24.?小时|daily|1d/.test(key)) return 1;
  if (/week|7.?天/.test(key)) return 2;
  return 3;
}
export function normalizeAntigravityQuota(raw) {
  const container = raw?.command?.data ?? raw?.response ?? raw?.data ?? raw?.result ?? raw ?? {};
  const groups = [];
  const rawGroups = Array.isArray(container.groups) ? container.groups
    : Array.isArray(container.quotaGroups) ? container.quotaGroups
    : null;
  if (rawGroups) {
    for (let i = 0; i < rawGroups.length; i++) {
      const g = rawGroups[i];
      if (!g || typeof g !== 'object') continue;
      const rawBuckets = Array.isArray(g.buckets) ? g.buckets
        : Array.isArray(g.windows) ? g.windows
        : Array.isArray(g.limits) ? g.limits
        : [];
      const windows = rawBuckets.map((b, idx) => normalizeAgyBucket(b, idx)).filter(Boolean).sort((a, b) => agyWindowRank(a) - agyWindowRank(b));
      if (windows.length) {
        groups.push({
          id: String(g.groupId ?? g.id ?? i),
          name: agyGroupLabel(g.groupName ?? g.displayName ?? g.name ?? g.label),
          windows,
        });
      }
    }
  }
  if (!groups.length) {
    const rawModels = Array.isArray(container.models) ? container.models
      : Array.isArray(container.modelConfigs) ? container.modelConfigs
      : null;
    if (rawModels) {
      const windows = rawModels
        .map((m, idx) => {
          const info = m?.quotaInfo ?? m;
          const w = normalizeAgyBucket(info, idx);
          if (!w) return null;
          return { ...w, label: m?.displayName ?? m?.label ?? m?.name ?? m?.modelId ?? w.label };
        })
        .filter(Boolean);
      if (windows.length) groups.push({ id: 'models', name: '模型额度', windows });
    }
  }
  const plan = container.planType ?? container.subscriptionTier ?? container.tier ?? raw?.planType ?? null;
  const rawCredits = container.credits ?? raw?.credits ?? null;
  const credits = rawCredits && typeof rawCredits === 'object' && (rawCredits.hasCredits || rawCredits.unlimited || rawCredits.balance != null || rawCredits.remaining != null)
    ? {
        hasCredits: Boolean(rawCredits.hasCredits ?? true),
        unlimited: Boolean(rawCredits.unlimited),
        ...(rawCredits.balance != null ? { balance: String(rawCredits.balance) } : rawCredits.remaining != null ? { balance: String(rawCredits.remaining) } : {}),
      }
    : null;
  const rawSummary = !groups.length && typeof raw?.rawText === 'string' && raw.rawText.trim() ? raw.rawText.trim().slice(0, 600) : null;
  return {
    engine: 'antigravity',
    label: 'Antigravity',
    status: groups.length || credits || rawSummary ? 'ok' : 'unavailable',
    ...(typeof plan === 'string' && plan.trim() ? { plan: plan.trim() } : {}),
    ...(credits ? { credits } : {}),
    ...(rawSummary ? { rawSummary } : {}),
    groups,
    fetchedAt: Date.now(),
  };
}

/** Minimal ACP v1 JSON-RPC client over an attached Duplex socket. */
class AcpConnection {
  constructor(socket, onMessage) {
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = null;
    socket.on('error', err => this.close(err));
    socket.on('close', () => this.close(Error('ANTIGRAVITY_DISCONNECTED')));
    this.rl = createInterface({ input: socket });
    this.rl.on('line', line => {
      if (this.closed || !line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg?.method) {
        try { onMessage(msg); } catch (err) { this.close(err instanceof Error ? err : Error(String(err))); }
        return;
      }
      if (typeof msg?.id !== 'number') return;
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) {
        const text = /authentication required/i.test(msg.error.message ?? '')
          ? 'Antigravity 需要登录，请在服务器运行 agy 登录'
          : (msg.error.message || `Antigravity ACP error (${msg.error.code})`);
        waiter.reject(Error(text));
      } else waiter.resolve(msg.result);
    });
  }
  call(method, params, timeoutMs = 45000) {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => this.close(Error(`ANTIGRAVITY_TIMEOUT:${method}`)), timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method, params) { this.write({ method, params }); }
  reply(id, result) { this.write({ id, result }); }
  unsupported(id, method) { this.write({ id, error: { code: -32601, message: `Unsupported ACP request: ${method}` } }); }
  write(obj) { if (!this.closed && !this.socket.destroyed) this.socket.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n'); }
  close(error = Error('ANTIGRAVITY_CLOSED')) {
    if (this.closed) return;
    this.closed = error;
    for (const w of this.pending.values()) { clearTimeout(w.timer); w.reject(error); }
    this.pending.clear();
    try { this.rl.close(); } catch {}
    try { this.socket.destroy(); } catch {}
  }
}

async function configureAcpSession(acp, session, { model, effort } = {}) {
  const { sessionId } = session;
  let configs = session.configOptions ?? [];
  const getConfig = cat => configs.find(item => item.category === cat || item.id === cat);
  const setConfig = async (option, value) => {
    if (!option || option.currentValue === value) return;
    const res = await acp.call('session/set_config_option', { sessionId, configId: option.id, value });
    if (Array.isArray(res?.configOptions) && res.configOptions.length) configs = res.configOptions;
  };
  let appliedModel = session.models?.currentModelId ?? null;
  const modelOpt = getConfig('model');
  if (modelOpt) {
    if (model) {
      const choice = modelOpt.options?.find(({ value }) => value === model || modelParts(value).id === model);
      if (choice) await setConfig(modelOpt, choice.value);
    }
    const chosen = getConfig('model')?.currentValue ?? modelOpt.currentValue;
    const thoughtOpt = getConfig('thought_level');
    if (effort && thoughtOpt?.options?.some(o => o.value === effort)) {
      await setConfig(thoughtOpt, effort);
    }
    const level = getConfig('thought_level')?.currentValue;
    appliedModel = level ? `${chosen}-${level}` : chosen;
  } else if (model || effort) {
    const currentParts = appliedModel ? modelParts(appliedModel) : {};
    const desired = model ?? currentParts.id;
    const variants = (session.models?.availableModels ?? []).filter(({ modelId }) => modelParts(modelId).id === desired);
    const chosen = effort
      ? variants.find(({ modelId }) => modelParts(modelId).effort === effort)?.modelId
      : (desired === currentParts.id ? appliedModel : variants[0]?.modelId);
    if (chosen && chosen !== appliedModel) {
      await acp.call('session/set_model', { sessionId, modelId: chosen });
      appliedModel = chosen;
    }
  }
  return appliedModel;
}

export class AntigravityTurns {
  constructor(host, socketPath, cwd, { bridgePath, nodePath = process.execPath, mcpDir, toolBudget } = {}) {
    this.host = host;
    this.db = host.store;
    this.socketPath = socketPath;
    this.cwd = cwd;
    this.bridgePath = bridgePath || fileURLToPath(new URL('../account-devices/wan/agy-mcp-bridge.mjs', import.meta.url));
    this.nodePath = nodePath;
    this.mcpDir = mcpDir || tmpdir();
    this.toolBudget = resolveToolBudget(toolBudget);
    this.active = new Map();
    this.modelCache = null;
    this.modelCacheAt = 0;
    this.modelRefresh = null;
  }

  turn(id) { return this.db.get('turns', id); }
  save(id, changes) { this.db.put('turns', id, { ...this.turn(id), ...changes }); }
  event(t, event) { this.db.append(t.sessionId, { ...event, engine: 'antigravity' }); this.host.emit('events', t.sessionId); }
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
      let socket, acp;
      try {
        socket = createConnection(this.socketPath);
        await Promise.race([once(socket, 'connect'), delay(4000).then(() => { throw Error('TIMEOUT'); })]);
        acp = new AcpConnection(socket, () => {});
        const init = await acp.call('initialize', { protocolVersion: 1, clientInfo: { name: 'anywhere-mesh', title: 'AnywhereMesh', version: '0.4.2' }, clientCapabilities: {} }, 8000);
        if (init.protocolVersion !== 1) throw Error('ACP_VERSION');
        const session = await acp.call('session/new', { cwd: this.cwd, mcpServers: [] }, 10000);
        const models = groupAvailableModels(session);
        if (models.length) {
          this.modelCache = { models };
          this.modelCacheAt = Date.now();
          return this.modelCache;
        }
      } catch {}
      finally {
        try { acp?.close(); } catch {}
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
    let socket, acp;
    const ac = new AbortController();
    try {
      socket = createConnection(this.socketPath);
      await Promise.race([once(socket, 'connect'), delay(4000, undefined, { signal: ac.signal }).then(() => { throw Error('TIMEOUT'); })]);
      acp = new AcpConnection(socket, () => {});
      const res = await acp.call('anywhere/quota', {}, 22000);
      return normalizeAntigravityQuota(res);
    } catch (error) {
      const msg = String(error?.message || 'QUOTA_UNAVAILABLE');
      return {
        engine: 'antigravity',
        label: 'Antigravity',
        status: 'error',
        error: /TIMEOUT/i.test(msg) ? '查询 Antigravity 额度超时，请稍后重试。'
          : /auth|login|登录/i.test(msg) ? 'Antigravity 尚未登录，请在服务器运行 agy 登录。'
          : /method not found|-32601|unsupported/i.test(msg) ? '服务端 Antigravity 代理尚未升级以支持额度查询。'
          : '暂时无法获取 Antigravity 额度信息。',
        groups: [],
        fetchedAt: Date.now(),
      };
    } finally {
      ac.abort();
      try { acp?.close(); } catch {}
      try { socket?.destroy(); } catch {}
    }
  }

  async workspaceTools(t) {
    const remote = await this.broker(t, 'workspace');
    assertIdentity(remote.grant, t.binding);
    if (!remote.confirmed || remote.grant.grantVersion !== t.binding.grantVersion || remote.grant.revoked) throw Error('LOCAL_PERMISSION_CHANGED');
    const tools = listTools(remote.grant, true, remote.sandbox?.supportedTools, remote.sandbox).filter(tool => workspaceNames.has(tool.name));
    if (this.db.attachments(t.sessionId).length) {
      tools.push(SESSION_TOOLS[0]);
      if (tools.some(x => x.name === 'workspace_write_file')) tools.push(SESSION_TOOLS[1]);
    }
    tools.push(...MEMORY_TOOLS);
    tools.sandbox = remote.sandbox;
    return tools;
  }

  async handleSessionReadAttachment(t, args) {
    const query = String(args?.attachment ?? '').trim();
    const match = this.db.attachments(t.sessionId).find(a => a.id === query || a.name === query);
    if (!match) return { isError: true, content: [{ type: 'text', text: `Attachment not found: ${query}` }] };
    const { att, bytes } = await this.host.readAttachmentBytes(t.sessionId, match.id);
    if (IMAGE_MIMES.has(att.mime)) {
      if (bytes.length > 5 * 1024 * 1024) return { isError: true, content: [{ type: 'text', text: 'Image attachment is too large to inspect inline.' }] };
      return { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: att.mime }, { type: 'text', text: `Image attachment ${att.name} (${att.mime}, ${bytes.length} bytes)` }] };
    }
    let body;
    if (extname(att.name).toLowerCase() === '.pdf' || att.mime === 'application/pdf') {
      try { body = await extractPdfText(this.host.attachmentPath(t.sessionId, att.id).path); }
      catch { return { isError: true, content: [{ type: 'text', text: 'Unable to extract text from PDF attachment.' }] }; }
    } else {
      if (bytes.subarray(0, 8192).includes(0)) return { isError: true, content: [{ type: 'text', text: `Binary attachment (${bytes.length} bytes) cannot be read as text.` }] };
      body = bytes.toString('utf8');
    }
    const lines = body.replace(/\r\n/g, '\n').split('\n');
    const start = Math.max(1, Number(args.offset ?? 1));
    const len = Math.min(500, Math.max(1, Number(args.length ?? 200)));
    const slice = lines.slice(start - 1, start - 1 + len).map((l, idx) => `${start + idx}\t${l}`).join('\n');
    const more = start - 1 + len < lines.length ? `\n… (${lines.length} total lines)` : '';
    return { content: [{ type: 'text', text: (slice || '(empty)') + more }] };
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

  async invokeMcpTool(t, run, params) {
    run.touch?.();
    const current = this.turn(t.id), session = this.host.session(t.sessionId);
    if (session.activeTurnId !== t.id || current.cancelRequested || run.ending) {
      return { isError: true, content: [{ type: 'text', text: 'Turn stopped.' }] };
    }
    const tool = String(params?.name ?? '');
    const args = (params?.arguments && typeof params.arguments === 'object') ? params.arguments : {};
    const callId = String(params?._meta?.progressToken || `agy-${t.id.slice(0, 8)}-${++run.callSeq}`);
    if (!run.tools.has(tool)) {
      return { isError: true, content: [{ type: 'text', text: 'Tool unavailable on this device.' }] };
    }
    if (tool === 'session_read_attachment') {
      const localVerdict = run.guard.checkLocal();
      if (!localVerdict.allowed) {
        this.emitNoticeOnce(t, run.guard, localVerdict.notice);
        return { isError: true, content: [{ type: 'text', text: localVerdict.modelMessage }] };
      }
      run.guard.recordLocal();
      this.event(t, { type: 'tool_call', id: callId, name: tool, input: boundEventInput(args), status: 'running' });
      const res = await this.handleSessionReadAttachment(current, args);
      const out = (res.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
      this.event(t, { type: 'tool_call', id: callId, name: tool, input: boundEventInput(args), status: res.isError ? 'failed' : 'completed', output: out.slice(0, 4500) });
      return res;
    }
    if (MEMORY_TOOL_NAMES.has(tool)) {
      const localVerdict = run.guard.checkLocal();
      if (!localVerdict.allowed) {
        this.emitNoticeOnce(t, run.guard, localVerdict.notice);
        return { isError: true, content: [{ type: 'text', text: localVerdict.modelMessage }] };
      }
      run.guard.recordLocal();
      this.event(t, { type: 'tool_call', id: callId, name: tool, input: boundEventInput(args), status: 'running' });
      const res = executeMemoryTool(this.db, t.workspaceId, tool, args);
      this.event(t, { type: 'tool_call', id: callId, name: tool, input: boundEventInput(args), status: res.ok ? 'completed' : 'failed', output: res.text.slice(0, 4500) });
      return { isError: !res.ok, content: [{ type: 'text', text: res.text }] };
    }
    let effectiveTool = tool, effectiveArgs = args;
    if (tool === 'session_send_attachment') {
      const query = String(args?.attachment ?? '').trim();
      const match = this.db.attachments(t.sessionId).find(a => a.id === query || a.name === query);
      if (!match) return { isError: true, content: [{ type: 'text', text: `Attachment not found: ${query}` }] };
      const { bytes } = await this.host.readAttachmentBytes(t.sessionId, match.id);
      if (bytes.includes(0) || bytes.length > 131072) {
        return { isError: true, content: [{ type: 'text', text: 'Only UTF-8 text attachments up to 128 KiB can be copied via session_send_attachment.' }] };
      }
      effectiveTool = 'workspace_write_file';
      effectiveArgs = { path: args.path, content: bytes.toString('utf8'), mode: 'rewrite', expectedRevision: args.expectedRevision };
    }
    try { normalize(effectiveTool, effectiveArgs); }
    catch {
      return { isError: true, content: [{ type: 'text', text: effectiveTool === 'workspace_read_file' ? 'Invalid arguments. Use a relative path, integer line offset, and 1 to 500 lines.' : 'Invalid arguments. Follow the advertised schema.' }] };
    }
    const inputHash = hash({ tool: effectiveTool, args: effectiveArgs });
    const existingDb = this.db.getTurnCall(t.id, callId);
    const legacyPrev = !existingDb ? current.calls?.find(call => call.id === callId) : null;
    const previous = existingDb ?? (legacyPrev ? { callId: legacyPrev.id, inputHash: legacyPrev.inputHash, counted: true } : null);
    if (previous && previous.inputHash !== inputHash) {
      return { isError: true, content: [{ type: 'text', text: 'Conflicting tool call.' }] };
    }
    if (!previous?.counted) {
      const verdict = run.guard.checkWorkspace(effectiveTool, inputHash);
      if (!verdict.allowed) {
        this.emitNoticeOnce(t, run.guard, verdict.notice);
        return { isError: true, content: [{ type: 'text', text: verdict.modelMessage }] };
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
        this.db.append(t.sessionId, { type: 'tool_call', id: callId, name: tool, input: eventInput, status: 'running', engine: 'antigravity' });
      });
      this.host.emit('events', t.sessionId);
    }
    const abortPreDispatch = (message, uiOutput = message) => {
      if (!previous?.counted) {
        this.db.tx(() => {
          this.db.updateTurnCall(t.id, callId, { state: 'aborted', ok: false, consumed: true, counted: false });
          this.db.append(t.sessionId, { type: 'tool_call', id: callId, name: tool, input: eventInput, status: 'failed', output: uiOutput, engine: 'antigravity' });
        });
        this.host.emit('events', t.sessionId);
      }
      return { isError: true, content: [{ type: 'text', text: message }] };
    };
    const h = await this.host.host(current);
    if (run.ending || this.turn(t.id).cancelRequested) {
      return abortPreDispatch('Turn stopped.', '已停止。');
    }
    const waitAlive = setInterval(() => run.touch?.(), 15000);
    waitAlive.unref?.();
    return this.host.withWorkspaceLock(t.workspaceId, async () => {
      clearInterval(waitAlive);
      if (run.ending || this.turn(t.id).cancelRequested) {
        return abortPreDispatch('Turn stopped.', '已停止。');
      }
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
      const saved = this.db.get('agyResults', ticket.operationId);
      if (saved) {
        await h.executor.consumeAfterPersist(saved.receipt);
        this.db.updateTurnCall(t.id, callId, {
          operationId: ticket.operationId,
          state: saved.reply?.isError ? 'failed' : 'completed',
          ok: !saved.reply?.isError,
          consumed: true,
          counted: true,
        });
        return appendAgyWarning(saved.reply, run.guard.softWarning(effectiveTool));
      }
      if (run.ending || this.turn(t.id).cancelRequested) {
        await this.broker(current, 'stopTurn', turnScope(current));
        return { isError: true, content: [{ type: 'text', text: 'Turn stopped.' }] };
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
    const content = items.length ? items : [{ type: 'text', text: text || task.state }];
    const reply = { isError: !ok, content };
    const receipt = { operationId, resultDigest: task.resultDigest, receiptId: 'antigravity:' + operationId };
    const eventInput = boundEventInput(call.args);
    this.db.tx(() => {
      if (!this.db.get('agyResults', operationId)) {
        this.db.put('agyResults', operationId, { receipt, reply, task, callId: call.id, fileVersions: data.result?.fileVersions });
        for (const version of data.result?.fileVersions ?? []) {
          this.db.put('revisions', hash({ sessionId: t.sessionId, workspaceId: t.workspaceId, path: version.path }), version);
        }
        this.db.append(t.sessionId, { type: 'tool_call', id: call.id, name: call.tool, input: eventInput, status: ok ? 'completed' : 'failed', output: text.slice(0, 8000), engine: 'antigravity' });
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
      return appendAgyWarning(reply, guard.softWarning(effectiveTool));
    }
    return reply;
  }

  buildTranscriptPrefix(t) {
    const before = t.historyBefore ?? 0;
    if (!before) return '';
    let cursor = 0;
    const lines = [];
    while (cursor < before) {
      const page = this.db.page(t.sessionId, cursor);
      if (!page.events.length) break;
      for (const { seq, event } of page.events) {
        if (seq > before) break;
        if (event.type === 'user_message') lines.push(`User: ${event.text}`);
        else if (event.type === 'assistant_text') lines.push(`Assistant: ${event.text}`);
        else if (event.type === 'tool_call' && ['completed', 'failed'].includes(event.status)) {
          lines.push(`[Tool ${event.name} (${event.status})]: ${(event.output ?? '').slice(0, 400)}`);
        }
      }
      cursor = page.throughSeq;
    }
    if (!lines.length) return '';
    return `[Previous conversation context]\n${lines.join('\n').slice(-16000)}\n\n[Current user message]\n`;
  }

  async startMcpBridgeServer(t, run, tools) {
    const token = randomBytes(32).toString('hex');
    const server = http.createServer(async (req, res) => {
      const reply = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST' || req.url !== '/mcp' || req.headers.authorization !== 'Bearer ' + token) {
        return reply(403, { error: { code: -32001, message: 'Forbidden' } });
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 512 * 1024) return reply(413, { error: { code: -32002, message: 'Too large' } });
      }
      let msg;
      try { msg = JSON.parse(raw); } catch { return reply(400, { error: { code: -32700, message: 'Parse error' } }); }
      if (msg.method === 'tools/list') {
        return reply(200, { result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
      }
      if (msg.method === 'tools/call') {
        const work = run.queue.then(() => this.invokeMcpTool(t, run, msg.params));
        run.queue = work.catch(() => {});
        try {
          const result = await work;
          return reply(200, { result });
        } catch (err) {
          return reply(200, { result: { isError: true, content: [{ type: 'text', text: err?.message || 'Tool execution failed' }] } });
        }
      }
      reply(200, { error: { code: -32601, message: 'Method not found' } });
    });
    mkdirSync(this.mcpDir, { recursive: true });
    const sockPath = join(this.mcpDir, `agy-mcp-${randomUUID()}.sock`);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sockPath, resolve); });
    // Accessible across service users (anywhere-wan <-> desktop); strictly protected by 256-bit Bearer token.
    chmodSync(sockPath, 0o666);
    return {
      socketPath: sockPath,
      token,
      close: () => new Promise(resolve => {
        server.closeAllConnections();
        server.close(() => { try { unlinkSync(sockPath); } catch {} resolve(); });
      }),
    };
  }

  async run(t) {
    const startedAt = Date.now();
    const socket = createConnection(this.socketPath);
    const connected = once(socket, 'connect');
    socket.on('error', () => {});
    const run = {
      socket, acp: null, sessionId: null, mcpServer: null, queue: Promise.resolve(),
      tools: new Set(), callSeq: 0, ending: false, prompting: false,
      text: '', thinking: '', usage: null, context: null, model: null,
      guard: new TurnToolGuard(this.toolBudget, this.db.listTurnCalls(t.id)),
    };
    this.active.set(t.id, run);
    const initialModel = (() => { try { return this.host.session(t.sessionId)?.options?.model ?? null; } catch { return null; } })();
    this.host?.emit?.('turn_start', { turnId: t.id, sessionId: t.sessionId, engine: 'antigravity', model: initialModel, startedAt });
    let outcome = 'interrupted';
    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { run.acp?.close(Error('ANTIGRAVITY_TURN_TIMEOUT')); }, 240000);
    };
    run.touch = resetIdle;
    resetIdle();
    const maxTimer = setTimeout(() => { run.acp?.close(Error('ANTIGRAVITY_TURN_TIMEOUT')); }, 1800000);
    try {
      const [tools] = await Promise.all([this.workspaceTools(t), connected]);
      run.tools = new Set(tools.map(tool => tool.name));
      run.mcpServer = await this.startMcpBridgeServer(t, run, tools);

      const acp = new AcpConnection(socket, msg => {
        resetIdle();
        const { id, method, params } = msg;
        if (id !== undefined) {
          if (method === 'session/request_permission' && params?.sessionId === run.sessionId) {
            const toolName = String(params?.toolCall?.name ?? '');
            const opts = Array.isArray(params?.options) ? params.options : [];
            const allowId = opts.find(o => o.kind === 'allow_once')?.optionId;
            const rejectId = opts.find(o => o.kind === 'reject_once')?.optionId;
            // ONLY allow our bound anywhere_workspace MCP tools; strictly reject all US-server built-in tools!
            if (toolName.startsWith(MCP_PREFIX) && allowId && !run.ending && !this.turn(t.id).cancelRequested) {
              acp.reply(id, { outcome: { outcome: 'selected', optionId: allowId } });
            } else {
              acp.reply(id, { outcome: rejectId ? { outcome: 'selected', optionId: rejectId } : { outcome: 'cancelled' } });
            }
            return;
          }
          acp.unsupported(id, method ?? '');
          return;
        }
        if (method === 'session/update' && params?.sessionId === run.sessionId && params?.update) {
          const u = params.update;
          if (u.sessionUpdate === 'usage_update' && typeof u.used === 'number' && Number.isFinite(u.used)) {
            const window = typeof u.size === 'number' && u.size > 0 ? u.size : (run.context?.window ?? 1048576);
            run.context = { used: u.used, window };
            this.host.delta(t.sessionId, { kind: 'context', used: u.used, window });
          } else if (run.prompting && u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && u.content.text) {
            run.text += u.content.text;
            this.host.delta(t.sessionId, { kind: 'text', id: t.id, text: u.content.text });
          } else if (run.prompting && u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text' && u.content.text) {
            run.thinking += u.content.text;
            this.host.delta(t.sessionId, { kind: 'thinking', id: t.id, text: u.content.text });
          }
        }
      });
      run.acp = acp;

      const init = await acp.call('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'anywhere-mesh', title: 'AnywhereMesh', version: '0.4.2' },
        clientCapabilities: {},
      });
      if (init.protocolVersion !== 1) throw Error('ANTIGRAVITY_PROTOCOL_UNSUPPORTED');

      const session = this.host.session(t.sessionId), saved = session.agySessionId;
      const opts = session.options ?? {};
      const signature = JSON.stringify(tools.map(tool => tool.name).sort());
      const resume = Boolean(saved && session.agyToolSet === signature);
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
      const mcpServers = [{
        name: MCP_NAME,
        command: this.nodePath,
        args: [this.bridgePath],
        env: [
          { name: 'ANYWHERE_MCP_SOCKET', value: run.mcpServer.socketPath },
          { name: 'ANYWHERE_MCP_TOKEN', value: run.mcpServer.token },
        ],
      }];
      const browserHint = browserInstructions(tools.sandbox);
      const sessionParams = {
        cwd: this.cwd,
        mcpServers,
        _meta: { antigravity: { systemPrompt: { append: [deviceInstructions(hasAtts), browserHint, memoryInstructions].filter(Boolean).join('\n\n') } } },
      };
      if (this.turn(t.id).cancelRequested) throw Error('TURN_STOPPED');
      const acpSession = resume
        ? await acp.call('session/resume', { ...sessionParams, sessionId: saved })
        : await acp.call('session/new', sessionParams);
      if (!acpSession?.sessionId) throw Error('ANTIGRAVITY_NO_SESSION');
      run.sessionId = acpSession.sessionId;
      if (!this.modelCache) {
        const grouped = groupAvailableModels(acpSession);
        if (grouped.length) { this.modelCache = { models: grouped }; this.modelCacheAt = Date.now(); }
      }
      run.model = await configureAcpSession(acp, acpSession, opts);
      this.db.tx(() => {
        const s = this.host.session(t.sessionId);
        if (s.activeTurnId !== t.id) throw Error('SESSION_TARGET_MISMATCH');
        this.db.put('sessions', s.id, { ...s, agySessionId: run.sessionId, agyToolSet: signature });
        this.save(t.id, { agySessionId: run.sessionId, model: run.model, state: 'running', modelTurnId: t.id });
      });
      if (this.turn(t.id).cancelRequested) throw Error('TURN_STOPPED');

      const atts = t.attachments ?? [];
      const images = atts.filter(a => IMAGE_MIMES.has(a.mime) && a.size <= 10 * 1024 * 1024);
      const prefix = (!resume && t.historyBefore > 0) ? this.buildTranscriptPrefix(t) : '';
      const promptText = prefix + describeAttachments(t.text, atts);
      const imageBlocks = [];
      for (const img of images) {
        const { bytes } = await this.host.readAttachmentBytes(t.sessionId, img.id);
        imageBlocks.push({ type: 'image', mimeType: img.mime, data: bytes.toString('base64') });
      }
      run.prompting = true;
      const result = await acp.call('session/prompt', {
        sessionId: run.sessionId,
        prompt: [{ type: 'text', text: promptText }, ...imageBlocks],
      }, 0);
      await run.queue;
      if (this.turn(t.id).cancelRequested) throw Error('TURN_STOPPED');
      if (result?.stopReason && result.stopReason !== 'end_turn') {
        throw Error(`ANTIGRAVITY_STOP:${result.stopReason}`);
      }
      if (!run.text.trim()) throw Error('ANTIGRAVITY_EMPTY_RESPONSE');
      const durationMs = Date.now() - startedAt;
      const u = result?.usage;
      const usage = u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedReadTokens } : undefined;
      this.db.tx(() => {
        if (run.thinking.trim()) {
          this.db.append(t.sessionId, { type: 'thinking', id: randomUUID(), text: run.thinking.trim().slice(0, 6000), engine: 'antigravity' });
        }
        for (let pos = 0; pos < run.text.length; pos += 16000) {
          this.db.append(t.sessionId, { type: 'assistant_text', id: t.id + '-' + pos, text: run.text.slice(pos, pos + 16000), engine: 'antigravity' });
        }
        this.save(t.id, { modelFinished: true, durationMs, usage, ...(run.context ? { context: run.context } : {}), model: run.model });
      });
      outcome = 'succeeded';
    } catch (error) {
      this.save(t.id, {
        error: String(error.message).slice(0, 280),
        durationMs: Date.now() - startedAt,
        ...(run.context ? { context: run.context } : {}),
        ...(run.model ? { model: run.model } : {}),
      });
      if (this.turn(t.id).cancelRequested) outcome = 'cancelled';
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      run.ending = true;
      run.prompting = false;
      run.acp?.close();
      socket.destroy();
      await run.queue;
      await run.mcpServer?.close().catch(() => {});
      this.save(t.id, { modelOutcome: outcome });
      try { await this.reconcile(this.turn(t.id)); }
      finally { this.active.delete(t.id); }
    }
  }

  async interrupt(id) {
    const run = this.active.get(id), t = this.turn(id);
    if (run?.acp && run.sessionId && run.prompting) {
      run.acp.notify('session/cancel', { sessionId: run.sessionId });
      setTimeout(() => run.acp?.close(Error('TURN_STOPPED')), 3000).unref();
    } else {
      run?.acp?.close(Error('TURN_STOPPED'));
    }
    if (this.db.hasTurnCalls(id) || t?.calls?.length) {
      await this.broker(t, 'stopTurn', turnScope(t)).catch(() => {});
    }
  }

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
            if (!this.db.get('agyUnsubmitted', t.id + ':' + call.callId)) {
              this.db.append(t.sessionId, { type: 'tool_call', id: call.callId, name: call.tool, input: boundEventInput(call.argsSummary), status: 'failed', output: '未提交到设备。', engine: 'antigravity' });
              this.db.put('agyUnsubmitted', t.id + ':' + call.callId, true);
            }
            if (!call.legacy) this.db.updateTurnCall(t.id, call.callId, { state: 'unsubmitted', ok: false, consumed: true, counted: false });
          });
          continue;
        }
        hasOperation = true;
        const opId = found.operationId;
        opIds.add(opId);
        const saved = this.db.get('agyResults', opId);
        if (saved) {
          await h.executor.consumeAfterPersist(saved.receipt);
          if (!call.legacy) {
            this.db.updateTurnCall(t.id, call.callId, {
              operationId: opId,
              state: saved.reply?.isError ? 'failed' : 'completed',
              ok: !saved.reply?.isError,
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
      const label = state === 'cancelled' ? '已停止生成。' : (latest.error ? `Antigravity 回合中断：${latest.error}` : 'Antigravity 回合中断，请查看工具记录后重新发送。');
      this.db.append(t.sessionId, {
        type: 'turn_end', turnId: t.id, ok: state === 'succeeded', engine: 'antigravity',
        ...(state === 'succeeded' ? {} : { error: label }),
        ...(latest.durationMs ? { durationMs: latest.durationMs } : {}),
        ...(latest.model ? { model: latest.model } : {}),
        ...(latest.usage ? { usage: latest.usage } : {}),
        ...(latest.context ? { context: latest.context } : {}),
        ...(toolCalls ? { toolCalls } : {}),
      });
      this.save(t.id, { state, done: true, consumed: true });
      for (const opId of opIds) this.db.deleteRecord('agyResults', opId);
      for (const call of finalCalls) {
        if (call.operationId) this.db.deleteRecord('agyResults', call.operationId);
        this.db.deleteRecord('agyUnsubmitted', t.id + ':' + call.callId);
      }
      const s = this.host.session(t.sessionId);
      const contextUsage = latest.context
        ? { used: latest.context.used, window: latest.context.window ?? s.contextUsage?.window ?? 1048576, engine: 'antigravity', model: latest.model ?? s.contextUsage?.model ?? null, updatedAt: Date.now() }
        : s.contextUsage;
      const nextSession = { ...s, ...(s.activeTurnId === t.id ? { activeTurnId: null } : {}), ...(contextUsage ? { contextUsage } : {}) };
      if (s.activeTurnId === t.id || latest.context) this.db.put('sessions', s.id, nextSession);
    });
    if (finalized) {
      this.host?.emit?.('turn_end', {
        turnId: t.id,
        sessionId: t.sessionId,
        engine: 'antigravity',
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
    if (!session?.agySessionId) throw Error('NOTHING_TO_COMPACT');
    const socket = createConnection(this.socketPath);
    const connected = once(socket, 'connect');
    socket.on('error', () => {});
    let acp = null;
    let latestContext = null;
    let summaryText = '';
    let activeSessionId = session.agySessionId;
    try {
      await Promise.race([connected, delay(6000).then(() => { throw Error('ANTIGRAVITY_CONNECT_TIMEOUT'); })]);
      acp = new AcpConnection(socket, msg => {
        const { id, method, params } = msg;
        if (id !== undefined) {
          if (method === 'session/request_permission') {
            const opts = Array.isArray(params?.options) ? params.options : [];
            const rejectId = opts.find(o => o.kind === 'reject_once')?.optionId;
            acp.reply(id, { outcome: rejectId ? { outcome: 'selected', optionId: rejectId } : { outcome: 'cancelled' } });
            return;
          }
          acp.unsupported(id, method ?? '');
          return;
        }
        if (method === 'session/update' && params?.sessionId === activeSessionId && params?.update) {
          const u = params.update;
          if (u.sessionUpdate === 'usage_update' && typeof u.used === 'number' && Number.isFinite(u.used)) {
            const window = typeof u.size === 'number' && u.size > 0 ? u.size : (latestContext?.window ?? session.contextUsage?.window ?? 1048576);
            latestContext = { used: u.used, window };
          } else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && u.content.text) {
            summaryText += u.content.text;
          }
        }
      });
      const init = await acp.call('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'anywhere-mesh', title: 'AnywhereMesh', version: '0.4.12' },
        clientCapabilities: {},
      });
      if (init.protocolVersion !== 1) throw Error('ANTIGRAVITY_PROTOCOL_UNSUPPORTED');
      const acpSession = await acp.call('session/resume', {
        cwd: this.cwd,
        mcpServers: [],
        sessionId: session.agySessionId,
      });
      if (!acpSession?.sessionId) throw Error('ANTIGRAVITY_NO_SESSION');
      activeSessionId = acpSession.sessionId;
      await acp.call('session/prompt', {
        sessionId: activeSessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      }, 120000);
      return {
        engine: 'antigravity',
        model: session.options?.model ?? session.contextUsage?.model ?? null,
        before: session.contextUsage ?? null,
        after: latestContext,
        summary: summaryText.trim().slice(0, 600),
        compacted: true,
      };
    } finally {
      try { acp?.close(); } catch {}
      try { socket.destroy(); } catch {}
    }
  }

  async close() {
    for (const [id, run] of this.active) {
      run.ending = true;
      await this.interrupt(id);
      run.socket.destroy();
    }
  }
}
