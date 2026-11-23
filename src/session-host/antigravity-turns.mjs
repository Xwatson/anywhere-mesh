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
import { CATALOG, listTools, normalize } from '../workspace/catalog.mjs';
import { assertIdentity } from '../execution/grants.mjs';
import { hash } from '../execution/protocol.mjs';

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
  constructor(host, socketPath, cwd, { bridgePath, nodePath = process.execPath, mcpDir } = {}) {
    this.host = host;
    this.db = host.store;
    this.socketPath = socketPath;
    this.cwd = cwd;
    this.bridgePath = bridgePath || fileURLToPath(new URL('../account-devices/wan/agy-mcp-bridge.mjs', import.meta.url));
    this.nodePath = nodePath;
    this.mcpDir = mcpDir || tmpdir();
    this.active = new Map();
    this.modelCache = null;
    this.modelCacheAt = 0;
    this.modelRefresh = null;
  }

  turn(id) { return this.db.get('turns', id); }
  save(id, changes) { this.db.put('turns', id, { ...this.turn(id), ...changes }); }
  event(t, event) { this.db.append(t.sessionId, { ...event, engine: 'antigravity' }); this.host.emit('events', t.sessionId); }
  broker(t, method, args) { return this.host.broker(this.host.workspace(t.workspaceId), method, args); }

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

  async workspaceTools(t) {
    const remote = await this.broker(t, 'workspace');
    assertIdentity(remote.grant, t.binding);
    if (!remote.confirmed || remote.grant.grantVersion !== t.binding.grantVersion || remote.grant.revoked) throw Error('LOCAL_PERMISSION_CHANGED');
    const tools = listTools(remote.grant, true, remote.sandbox?.supportedTools).filter(tool => workspaceNames.has(tool.name));
    if (remote.sandbox?.shell === 'cmd.exe') {
      const command = tools.find(tool => tool.name === 'workspace_run');
      if (command) command.description = 'Run a finite Windows cmd.exe project command in an offline AppContainer. Normal exit writes project changes back. Node and npm are available.';
    }
    if (this.db.attachments(t.sessionId).length) {
      tools.push(SESSION_TOOLS[0]);
      if (tools.some(x => x.name === 'workspace_write_file')) tools.push(SESSION_TOOLS[1]);
    }
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
      this.event(t, { type: 'tool_call', id: callId, name: tool, input: args, status: 'running' });
      const res = await this.handleSessionReadAttachment(current, args);
      const out = (res.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
      this.event(t, { type: 'tool_call', id: callId, name: tool, input: args, status: res.isError ? 'failed' : 'completed', output: out.slice(0, 4500) });
      return res;
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
    const previous = current.calls.find(call => call.id === callId);
    if (previous && previous.inputHash !== hash({ tool: effectiveTool, args: effectiveArgs })) {
      return { isError: true, content: [{ type: 'text', text: 'Conflicting tool call.' }] };
    }
    if (!previous && current.calls.length >= 60) {
      return { isError: true, content: [{ type: 'text', text: 'Tool limit reached for this turn.' }] };
    }
    if (!previous) {
      this.db.tx(() => {
        this.save(t.id, { calls: [...current.calls, { id: callId, tool: effectiveTool, args: effectiveArgs, inputHash: hash({ tool: effectiveTool, args: effectiveArgs }) }] });
        this.db.append(t.sessionId, { type: 'tool_call', id: callId, name: tool, input: args, status: 'running', engine: 'antigravity' });
      });
      this.host.emit('events', t.sessionId);
    }
    const h = await this.host.host(current);
    if (run.ending || this.turn(t.id).cancelRequested) {
      return { isError: true, content: [{ type: 'text', text: 'Turn stopped.' }] };
    }
    await this.waitForWorkspaceReady(current, run, 20000);
    run.touch?.();
    if (!(await this.workspaceTools(current)).some(item => item.name === effectiveTool)) {
      return { isError: true, content: [{ type: 'text', text: 'Workspace permission changed.' }] };
    }
    const ticket = await h.executor.issue(callId, effectiveTool, effectiveArgs);
    this.save(t.id, { operationId: ticket.operationId });
    const saved = this.db.get('agyResults', ticket.operationId);
    if (saved) {
      await h.executor.consumeAfterPersist(saved.receipt);
      return saved.reply;
    }
    if (run.ending || this.turn(t.id).cancelRequested) {
      await this.broker(current, 'stopTurn', turnScope(current));
      return { isError: true, content: [{ type: 'text', text: 'Turn stopped.' }] };
    }
    let result = await h.client.callTool({ name: effectiveTool, arguments: effectiveArgs, _meta: { 'anywhere/callTicket': ticket.ticket } });
    const until = Date.now() + 180000;
    let outputSeq = 0;
    while (result.structuredContent?.task && !result.structuredContent.task.resultReady) {
      run.touch?.();
      if (run.ending || result.structuredContent.task.state === 'unknown' || Date.now() > until) throw Error('WORKSPACE_RESULT_PENDING');
      const receivedSeq = result.structuredContent.task.receivedSeq ?? 0;
      if (receivedSeq > outputSeq) {
        try {
          const out = await h.executor.output(ticket.operationId, outputSeq);
          const chunk = out.rows.map(r => r.data).join('');
          if (chunk) this.host.delta(t.sessionId, { kind: 'tool_output', id: callId, text: chunk });
          outputSeq = out.nextSeq;
        } catch {}
      }
      await delay(250);
      result = await h.client.callTool({ name: 'workspace_task_status', arguments: { operationId: ticket.operationId } });
    }
    return this.capture(current, { id: callId, tool, args }, h, ticket.operationId, result);
  }

  async capture(t, call, h, operationId, result) {
    const data = result.structuredContent, task = data?.task;
    if (!task?.resultReady || task.operationId !== operationId || data.workspaceId !== t.workspaceId) throw Error('WORKSPACE_RESULT_PENDING');
    const items = result.content ?? data.result?.response?.content ?? [];
    const text = items.filter(x => x.type === 'text').map(x => x.text).join('\n');
    const ok = !result.isError && task.state === 'succeeded';
    const content = items.length ? items : [{ type: 'text', text: text || task.state }];
    const reply = { isError: !ok, content };
    const receipt = { operationId, resultDigest: task.resultDigest, receiptId: 'antigravity:' + operationId };
    this.db.tx(() => {
      if (this.db.get('agyResults', operationId)) return;
      this.db.put('agyResults', operationId, { receipt, reply, task, callId: call.id, fileVersions: data.result?.fileVersions });
      for (const version of data.result?.fileVersions ?? []) {
        this.db.put('revisions', hash({ sessionId: t.sessionId, workspaceId: t.workspaceId, path: version.path }), version);
      }
      this.db.append(t.sessionId, { type: 'tool_call', id: call.id, name: call.tool, input: call.args, status: ok ? 'completed' : 'failed', output: text.slice(0, 8000), engine: 'antigravity' });
    });
    this.host.emit('events', t.sessionId);
    await h.executor.consumeAfterPersist(receipt);
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
      text: '', thinking: '', usage: null, model: null,
    };
    this.active.set(t.id, run);
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
        if (method === 'session/update' && params?.sessionId === run.sessionId && run.prompting && params?.update) {
          const u = params.update;
          if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && u.content.text) {
            run.text += u.content.text;
            this.host.delta(t.sessionId, { kind: 'text', id: t.id, text: u.content.text });
          } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text' && u.content.text) {
            run.thinking += u.content.text;
            this.host.delta(t.sessionId, { kind: 'thinking', id: t.id, text: u.content.text });
          } else if (u.sessionUpdate === 'usage_update' && typeof u.used === 'number') {
            this.host.delta(t.sessionId, { kind: 'context', used: u.used, window: u.size });
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
      const mcpServers = [{
        name: MCP_NAME,
        command: this.nodePath,
        args: [this.bridgePath],
        env: [
          { name: 'ANYWHERE_MCP_SOCKET', value: run.mcpServer.socketPath },
          { name: 'ANYWHERE_MCP_TOKEN', value: run.mcpServer.token },
        ],
      }];
      const sessionParams = {
        cwd: this.cwd,
        mcpServers,
        _meta: { antigravity: { systemPrompt: { append: deviceInstructions(hasAtts) } } },
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
        this.save(t.id, { modelFinished: true, durationMs, usage, model: run.model });
      });
      outcome = 'succeeded';
    } catch (error) {
      this.save(t.id, { error: String(error.message).slice(0, 280), durationMs: Date.now() - startedAt });
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
    if (t?.calls?.length) await this.broker(t, 'stopTurn', turnScope(t)).catch(() => {});
  }

  async reconcile(t) {
    if (t.consumed) return;
    let hasOperation = false;
    if (t.calls?.length) {
      const h = await this.host.host(t);
      for (const call of t.calls) {
        const found = await h.executor.recover(call.id);
        if (!found) {
          if (!this.db.get('agyUnsubmitted', t.id + ':' + call.id)) this.db.tx(() => {
            this.db.append(t.sessionId, { type: 'tool_call', id: call.id, name: call.tool, input: call.args, status: 'failed', output: '未提交到设备。', engine: 'antigravity' });
            this.db.put('agyUnsubmitted', t.id + ':' + call.id, true);
          });
          continue;
        }
        hasOperation = true;
        const opId = found.operationId, saved = this.db.get('agyResults', opId);
        if (saved) { await h.executor.consumeAfterPersist(saved.receipt); continue; }
        const result = await h.executor.status(opId);
        if (!result.structuredContent.task.resultReady) {
          await this.broker(t, 'stopTurn', turnScope(t));
          this.save(t.id, { state: result.structuredContent.task.state });
          return;
        }
        await this.capture(t, call, h, opId, result);
      }
    }
    if (hasOperation) await this.broker(t, 'reasoningIdle', turnScope(t));
    const latest = this.turn(t.id);
    const state = latest.cancelRequested ? 'cancelled' : latest.modelFinished ? 'succeeded' : 'interrupted';
    this.db.tx(() => {
      if (this.turn(t.id).consumed) return;
      const label = state === 'cancelled' ? '已停止生成。' : (latest.error ? `Antigravity 回合中断：${latest.error}` : 'Antigravity 回合中断，请查看工具记录后重新发送。');
      this.db.append(t.sessionId, {
        type: 'turn_end', ok: state === 'succeeded', engine: 'antigravity',
        ...(state === 'succeeded' ? {} : { error: label }),
        ...(latest.durationMs ? { durationMs: latest.durationMs } : {}),
        ...(latest.model ? { model: latest.model } : {}),
        ...(latest.usage ? { usage: latest.usage } : {}),
      });
      this.save(t.id, { state, done: true, consumed: true });
      const s = this.host.session(t.sessionId);
      if (s.activeTurnId === t.id) this.db.put('sessions', s.id, { ...s, activeTurnId: null });
    });
    await this.host.closeHost(t.id);
    this.host.emit('events', t.sessionId);
  }

  async close() {
    for (const [id, run] of this.active) {
      run.ending = true;
      await this.interrupt(id);
      run.socket.destroy();
    }
  }
}
