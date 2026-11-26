import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { control } from '../execution/control.mjs';
import { WorkspaceExecutor } from '../workspace/executor.mjs';
import { LIFECYCLE } from '../workspace/catalog.mjs';
import { TERMINAL, exact, fail, hash } from '../execution/protocol.mjs';
import { SessionStore, uuid, fields, text } from './store.mjs';
import { parseMock } from './mock.mjs';
import { TurnLaunchLimiter } from './launch-limiter.mjs';
import { PROJECT_DOC_CANDIDATES, extractProjectDocsFromReadResult, normalizeMemoryScope } from './memory.mjs';
import { formatAnswersForPrompt, normalizeSubmittedAnswers } from './questions.mjs';

function createDirectWorkspaceClient(executor, { waitMs = 0 } = {}) {
  return {
    async callTool({ name, arguments: args = {}, _meta } = {}) {
      try {
        const lifecycle = LIFECYCLE.find(t => t.name === name);
        if (lifecycle) {
          exact(args, Object.keys(lifecycle.inputSchema.properties));
          if (name === 'workspace_task_status') return await executor.status(args.operationId);
          if (name === 'workspace_task_cancel') return await executor.cancel(args.operationId);
          const value = name === 'workspace_capabilities'
            ? await executor.capabilities()
            : await executor.output(args.operationId, args.afterSeq ?? 0);
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
        }
        const ticket = _meta?.['anywhere/callTicket'];
        if (typeof ticket !== 'string') fail('CALL_TICKET_REQUIRED');
        return await executor.invoke(name, args, ticket, { waitMs });
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error.code ?? error.message }],
          structuredContent: {
            error: error.code ?? error.message,
            recovery: 'Use the same host call ticket to reconcile. An error response does not prove that execution did not occur.',
          },
        };
      }
    },
    async close() {},
  };
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const sanitizeFileName = name => basename(String(name || 'file')).replace(/[\x00-\x1f/\\<>:"|?*]/g, '_').trim().slice(0, 120) || 'file';

export class SessionHost extends EventEmitter {
  constructor(config) {
    super(); this.config = config; this.store = new SessionStore(config.stateDir + '/history.sqlite');
    this.workspaces = new Map(config.workspaces.map(w => [w.id, w])); this.hosts = new Map(); this.busy = new Set(); this.work = new Set(); this.closing = false;
    this.launchLimiter = config.launchLimiter ?? new TurnLaunchLimiter(config.launchLimiterOptions);
    this.ownsLimiter = !config.launchLimiter;
    this.queued = new Set();
    this.compacting = new Set();
    this.workspaceLocks = config.workspaceLocks ?? new Map();
    this.projectDocInflight = new Map();
  }
  withWorkspaceLock(workspaceId, fn) {
    const prev = this.workspaceLocks.get(workspaceId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(() => {}, () => {});
    this.workspaceLocks.set(workspaceId, settled);
    settled.finally(() => { if (this.workspaceLocks.get(workspaceId) === settled) this.workspaceLocks.delete(workspaceId); });
    return run;
  }
  async trySettleWorkspaceOp(w, opId) {
    let op;
    try { op = await this.broker(w, 'operation', { operationId: opId }); }
    catch { return false; }
    if (!op || op.state === 'unknown') return false;
    if ((op.state === 'not_received' || op.state === 'prepared') && !op.cancelId) {
      await this.broker(w, 'cancel', { operationId: opId }).catch(() => {});
      return true;
    }
    if (!TERMINAL.has(op.state) || op.receivedSeq < op.lastSeq || op.delivery === 'consumed') {
      return false;
    }
    const ref = this.store.get('operations', opId);
    const callRec = ref ? this.store.get('calls', ref.key) : null;
    if (!callRec?.binding) return false;
    const binding = callRec.binding;
    const callId = callRec.params?.toolCallId ?? '';
    const executorFor = (ownerTurn) => {
      const existing = ownerTurn ? this.hosts.get(ownerTurn.id) : null;
      return existing?.executor ?? new WorkspaceExecutor({
        journal: this.store,
        binding,
        control: (m, p) => this.broker(w, m, p),
      });
    };
    if (callId.startsWith('preload-docs:')) {
      const exec = executorFor(null);
      await exec.consumeAfterPersist({
        operationId: opId,
        resultDigest: op.resultDigest,
        receiptId: 'preload-docs:' + opId,
      });
      return true;
    }
    const ownerTurn = this.store.get('turns', binding.turnId) ??
      this.store.all('turns').find(t => t.sessionId === binding.sessionId && (t.modelTurnId === binding.turnId || t.binding?.turnId === binding.turnId));
    if (!ownerTurn) return false;
    if (ownerTurn.engine === 'antigravity' && this.antigravity) {
      const exec = executorFor(ownerTurn);
      const saved = this.store.get('agyResults', opId);
      if (saved) {
        await exec.consumeAfterPersist(saved.receipt);
        if (callId) {
          this.store.updateTurnCall(ownerTurn.id, callId, {
            operationId: opId,
            state: saved.reply?.isError ? 'failed' : 'completed',
            ok: !saved.reply?.isError,
            consumed: true,
            counted: true,
          });
        }
        return true;
      }
      const status = await exec.status(opId);
      if (!status?.structuredContent?.task?.resultReady) return false;
      const tc = callId ? this.store.getTurnCall(ownerTurn.id, callId) : null;
      await this.antigravity.capture(
        ownerTurn,
        {
          id: callId || opId,
          tool: tc?.tool ?? callRec.toolName,
          effectiveTool: tc?.effectiveTool ?? callRec.toolName,
          args: tc?.argsSummary ?? callRec.params?.args?.arguments ?? callRec.params?.args ?? {},
          inputHash: tc?.inputHash ?? callRec.inputHash ?? '',
        },
        { executor: exec },
        opId,
        status,
      );
      return true;
    }
    if (ownerTurn.engine === 'codex' && this.codex) {
      const exec = executorFor(ownerTurn);
      const saved = this.store.get('codexResults', opId);
      if (saved) {
        await exec.consumeAfterPersist(saved.receipt);
        if (callId) {
          this.store.updateTurnCall(ownerTurn.id, callId, {
            operationId: opId,
            state: saved.reply?.success === false ? 'failed' : 'completed',
            ok: saved.reply?.success !== false,
            consumed: true,
            counted: true,
          });
        }
        return true;
      }
      const status = await exec.status(opId);
      if (!status?.structuredContent?.task?.resultReady) return false;
      const tc = callId ? this.store.getTurnCall(ownerTurn.id, callId) : null;
      await this.codex.capture(
        ownerTurn,
        {
          id: callId || opId,
          tool: tc?.tool ?? callRec.toolName,
          effectiveTool: tc?.effectiveTool ?? callRec.toolName,
          args: tc?.argsSummary ?? callRec.params?.args?.arguments ?? callRec.params?.args ?? {},
          inputHash: tc?.inputHash ?? callRec.inputHash ?? '',
        },
        { executor: exec },
        opId,
        status,
      );
      return true;
    }
    if (!ownerTurn.engine && !ownerTurn.consumed) {
      await this.refresh(ownerTurn.id);
      return true;
    }
    return false;
  }
  async reconcileWorkspaceBlockers(workspaceId, { waitMs = 20000, shouldStop = () => false, onProgress } = {}) {
    const w = this.workspaces.get(workspaceId);
    if (!w) return null;
    const deadline = Date.now() + waitMs;
    let lastInfo = null;
    while (!this.closing && !shouldStop()) {
      onProgress?.();
      try {
        const info = await this.broker(w, 'workspace');
        lastInfo = info;
        if (info.unknownOperations?.length) return info;
        const blockers = info.blockers ?? [];
        const activeOps = info.activeOperations ?? [];
        if (info.confirmed && info.phase === 'ready' && !blockers.length && !activeOps.length) {
          return info;
        }
        if (info.confirmed && info.phase === 'ready') {
          const candidates = [...new Set([...blockers, ...activeOps])];
          let progressed = false;
          for (const opId of candidates) {
            if (shouldStop()) break;
            try {
              if (await this.trySettleWorkspaceOp(w, opId)) progressed = true;
            } catch {}
          }
          if (progressed) continue;
        }
      } catch {}
      if (Date.now() >= deadline) return lastInfo;
      await delay(200);
    }
    return lastInfo;
  }
  workspace(id) { uuid(id); const w = this.workspaces.get(id); if (!w) throw Error('WORKSPACE_NOT_ALLOWED'); return w; }
  broker(w, method, params = {}) { return control(w.brokerDir + '/control.sock', method, params); }
  session(id) {
    const s = this.store.session(id), w = this.workspace(s.workspaceId);
    if (this.config.accountId && this.config.requireDeviceBinding &&
        (s.accountId !== this.config.accountId || s.deviceId !== w.grant.deviceId)) throw Error('SESSION_TARGET_MISMATCH');
    return s;
  }
  sessions() {
    return this.store.all('sessions').map(s => ({
      ...s,
      compacting: this.compacting.has(s.id),
      activeTurn: s.activeTurnId ? this.publicTurn(this.store.get('turns', s.activeTurnId)) : null,
    })).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  publicTurn(t) {
    if (!t) return null;
    const q = !t.done ? this.launchLimiter?.status(t.id) : null;
    const pendingQ = !t.done && t.engine === 'codex' ? this.codex?.pendingQuestionForTurn?.(t.id) : null;
    return {
      id: t.id, sessionId: t.sessionId, workspaceId: t.workspaceId, operationId: t.operationId ?? null,
      state: q ? 'queued' : (pendingQ ? 'waiting_input' : t.state), done: Boolean(t.done), consumed: Boolean(t.consumed),
      cancelRequested: Boolean(t.cancelRequested), outcome: t.outcome ?? null,
      ...(pendingQ ? { waitingForInput: true, pendingQuestionId: pendingQ.id } : {}),
      ...(q ? { queued: true, queuePosition: q.position, queueRemainingMs: q.remainingMs, queueDelayMs: q.delayMs } : {}),
    };
  }
  delta(sessionId, payload) { this.emit('delta', sessionId, payload); }
  async projectStates() {
    return Promise.all([...this.workspaces.values()].map(async w => {
      const info = await this.broker(w,'workspace'); return { id:w.id,label:w.label,deviceId:this.config.deviceId,
        phase:info.phase,confirmed:info.confirmed,permission:{mode:info.grant.mode,version:info.grant.grantVersion},blockers:info.blockers.length };
    }));
  }
  create(body) {
    fields(body,['requestId','workspaceId','title'],['options']);
    const w = this.workspace(body.workspaceId);
    const created = this.store.create(body, this.config.requireDeviceBinding ? w.grant : undefined);
    this.emit('state');
    return created;
  }
  renameSession(sessionId, title) {
    this.session(sessionId);
    const updated = this.store.rename(sessionId, title);
    this.emit('state');
    return updated;
  }
  updateSessionOptions(sessionId, options) {
    this.session(sessionId);
    const updated = this.store.updateOptions(sessionId, options);
    this.emit('state');
    return updated;
  }
  async compactSession(sessionId) {
    const s = this.session(sessionId);
    if (s.activeTurnId || this.compacting.has(sessionId)) throw Error('SESSION_BUSY');
    const requested = s.options?.agent;
    const engine = requested === 'antigravity' && this.antigravity ? 'antigravity'
      : requested === 'codex' && this.codex ? 'codex'
      : s.agySessionId && this.antigravity && !s.codexThreadId ? 'antigravity'
      : s.codexThreadId && this.codex ? 'codex'
      : this.codex ? 'codex'
      : this.antigravity ? 'antigravity'
      : null;
    if (!engine) throw Error('COMPACT_UNSUPPORTED');
    if (engine === 'codex' && !s.codexThreadId) throw Error('NOTHING_TO_COMPACT');
    if (engine === 'antigravity' && !s.agySessionId) throw Error('NOTHING_TO_COMPACT');
    this.compacting.add(sessionId);
    this.emit('state');
    try {
      const res = engine === 'codex'
        ? await this.codex.compact(s)
        : await this.antigravity.compact(s);
      const now = Date.now();
      const before = s.contextUsage ? { used: s.contextUsage.used, window: s.contextUsage.window ?? null } : null;
      const after = res?.after && typeof res.after.used === 'number'
        ? {
            used: res.after.used,
            window: res.after.window ?? s.contextUsage?.window ?? null,
            engine,
            model: res.model ?? s.contextUsage?.model ?? s.options?.model ?? null,
            updatedAt: now,
            compactedAt: now,
          }
        : (s.contextUsage ? { ...s.contextUsage, engine, updatedAt: now, compactedAt: now } : null);
      this.store.tx(() => {
        const cur = this.session(sessionId);
        if (after) this.store.put('sessions', cur.id, { ...cur, contextUsage: after, updatedAt: now });
        this.store.append(sessionId, {
          type: 'context_compacted',
          engine,
          ...(before ? { before } : {}),
          ...(after ? { after: { used: after.used, window: after.window ?? null } } : {}),
          ...(res?.summary ? { summary: res.summary } : {}),
        });
      });
      if (after && typeof after.used === 'number') {
        this.delta(sessionId, { kind: 'context', used: after.used, window: after.window ?? undefined, compactedAt: now });
      }
      this.emit('events', sessionId);
      this.emit('state');
      return { ok: true, engine, before, after, ...(res?.summary ? { summary: res.summary } : {}) };
    } finally {
      this.compacting.delete(sessionId);
      this.emit('state');
    }
  }
  async deleteSession(sessionId) {
    this.session(sessionId);
    const removed = this.store.remove(sessionId);
    await rm(join(this.config.stateDir, 'attachments', sessionId), { recursive: true, force: true }).catch(() => {});
    this.emit('state');
    return { ok: true, id: removed.id };
  }
  listMemories(scope, workspaceId = null) {
    const cleanScope = normalizeMemoryScope(scope);
    if (cleanScope === 'workspace') this.workspace(workspaceId);
    return this.store.listMemories(cleanScope, cleanScope === 'workspace' ? workspaceId : null);
  }
  saveMemory(scope, workspaceId, input) {
    const cleanScope = normalizeMemoryScope(scope);
    if (cleanScope === 'workspace') this.workspace(workspaceId);
    return this.store.upsertMemory(cleanScope, cleanScope === 'workspace' ? workspaceId : null, input);
  }
  deleteMemory(scope, workspaceId, key) {
    const cleanScope = normalizeMemoryScope(scope);
    if (cleanScope === 'workspace') this.workspace(workspaceId);
    return this.store.deleteMemory(cleanScope, cleanScope === 'workspace' ? workspaceId : null, key);
  }
  clearMemories(scope, workspaceId = null) {
    const cleanScope = normalizeMemoryScope(scope);
    if (cleanScope === 'workspace') this.workspace(workspaceId);
    return this.store.clearMemories(cleanScope, cleanScope === 'workspace' ? workspaceId : null);
  }
  purgeWorkspaceMemories(workspaceId) {
    return this.store.purgeWorkspaceMemories(workspaceId);
  }
  async preloadProjectDocs(t) {
    if (!t?.binding) return [];
    const w = this.workspaces.get(t.workspaceId);
    if (!w) return [];
    const cacheKey = `${t.workspaceId}:${t.binding.grantVersion}`;
    const recordVersions = (fileVersions) => {
      if (!fileVersions?.length) return;
      this.store.tx(() => {
        for (const version of fileVersions) {
          if (version?.path) {
            this.store.put('revisions', hash({ sessionId: t.sessionId, workspaceId: t.workspaceId, path: version.path }), version);
          }
        }
      });
    };
    const inflight = this.projectDocInflight.get(cacheKey);
    if (inflight) {
      const shared = await inflight;
      recordVersions(shared.fileVersions);
      return shared.docs;
    }
    const work = (async () => {
      try {
        return await this.withWorkspaceLock(t.workspaceId, async () => {
          if (this.closing || this.store.get('turns', t.id)?.cancelRequested) return { docs: [], fileVersions: [] };
          const info = await this.broker(w, 'workspace');
          if (!info?.confirmed || info.phase !== 'ready' || info.grant?.revoked) return { docs: [], fileVersions: [] };
          if (info.grant.grantVersion !== t.binding.grantVersion) return { docs: [], fileVersions: [] };
          const executor = new WorkspaceExecutor({
            journal: this.store,
            binding: t.binding,
            control: (m, p) => this.broker(w, m, p),
          });
          const callId = 'preload-docs:' + t.id;
          const args = { paths: [...PROJECT_DOC_CANDIDATES] };
          const ticket = await executor.issue(callId, 'workspace_read_files', args, { expiresAt: Date.now() + 15000 });
          let result = null;
          try {
            result = await executor.invoke('workspace_read_files', args, ticket.ticket, { waitMs: 6000 });
          } catch {}
          let task = result?.structuredContent?.task;
          if (!task?.resultReady) {
            if (task?.state !== 'unknown') {
              await executor.cancel(ticket.operationId).catch(() => {});
            }
            const drainUntil = Date.now() + 8000;
            while (Date.now() < drainUntil) {
              try {
                const st = await executor.status(ticket.operationId);
                task = st?.structuredContent?.task;
                if (task?.resultReady) {
                  await executor.consumeAfterPersist({
                    operationId: ticket.operationId,
                    resultDigest: task.resultDigest,
                    receiptId: 'preload-docs:' + ticket.operationId,
                  });
                  break;
                }
                if (task?.state === 'unknown') break;
              } catch {}
              await delay(100);
            }
            return { docs: [], fileVersions: [] };
          }
          const extracted = extractProjectDocsFromReadResult(PROJECT_DOC_CANDIDATES, result);
          await executor.consumeAfterPersist({
            operationId: ticket.operationId,
            resultDigest: task.resultDigest,
            receiptId: 'preload-docs:' + ticket.operationId,
          });
          return extracted;
        });
      } catch {
        return { docs: [], fileVersions: [] };
      } finally {
        if (this.projectDocInflight.get(cacheKey) === work) this.projectDocInflight.delete(cacheKey);
      }
    })();
    this.projectDocInflight.set(cacheKey, work);
    const extracted = await work;
    recordVersions(extracted.fileVersions);
    return extracted.docs;
  }
  async saveAttachment(sessionId, { name, mime, bytes }) {
    this.session(sessionId);
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw Error('INVALID_ATTACHMENT');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw Error('BODY_LIMIT');
    const safeName = sanitizeFileName(name);
    const safeMime = typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime.split(';')[0].trim()) ? mime.split(';')[0].trim().toLowerCase() : 'application/octet-stream';
    const id = randomUUID();
    const dir = join(this.config.stateDir, 'attachments', sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const storedName = `${id.slice(0, 8)}-${safeName}`;
    const fullPath = join(dir, storedName);
    await writeFile(fullPath, bytes, { flag: 'wx', mode: 0o600 });
    const meta = { id, name: safeName, mime: safeMime, size: bytes.length, storedName, createdAt: Date.now() };
    this.store.addAttachment(sessionId, meta);
    return { id, name: safeName, mime: safeMime, size: bytes.length };
  }
  attachmentPath(sessionId, attId) {
    const att = this.store.attachment(sessionId, attId);
    return { att, path: join(this.config.stateDir, 'attachments', sessionId, att.storedName) };
  }
  async readAttachmentBytes(sessionId, attId) {
    const { att, path } = this.attachmentPath(sessionId, attId);
    return { att, bytes: await readFile(path) };
  }
  async send(sessionId, body) {
    fields(body,['requestId','text'],['attachments']); uuid(body.requestId); text(body.text);
    const attIds = body.attachments ?? [];
    if (!Array.isArray(attIds) || attIds.length > 8) throw Error('INVALID_FIELDS');
    const resolvedAtts = attIds.map(id => {
      const { att, path } = this.attachmentPath(sessionId, id);
      return { id: att.id, name: att.name, mime: att.mime, size: att.size, path };
    });
    const s = this.session(sessionId);
    const payload = { kind:'send',sessionId,text:body.text,...(attIds.length ? { attachments: attIds } : {}) };
    const prior = this.store.request(body.requestId,payload);
    if (prior) return prior;
    if (s.activeTurnId) throw Error('SESSION_BUSY');
    const w = this.workspace(s.workspaceId);
    const diagnostic = /^\s*\/(?:read|list|search|append|build|long|run|help)(?:\s|$)/.test(body.text);
    const requestedAgent = s.options?.agent;
    const chosenEngine = diagnostic ? null :
      requestedAgent === 'antigravity' && this.antigravity ? 'antigravity' :
      requestedAgent === 'codex' && this.codex ? 'codex' :
      this.codex ? 'codex' : this.antigravity ? 'antigravity' : null;
    const parsed = chosenEngine ? { engine: chosenEngine, text: body.text, attachments: resolvedAtts, calls: [] } :
      parseMock(body.text, path => this.store.get('revisions',hash({sessionId,workspaceId:w.id,path}))?.revision);
    let binding;
    if (!parsed.help) {
      const remote = await this.broker(w,'workspace');
      if (this.config.requireDeviceBinding && (remote.grant.accountId !== s.accountId ||
          remote.grant.deviceId !== s.deviceId || remote.grant.workspaceId !== s.workspaceId)) throw Error('SESSION_TARGET_MISMATCH');
      const concurrentReceipt = this.store.request(body.requestId,payload);
      if (concurrentReceipt) return concurrentReceipt;
      const hasUnknown = Array.isArray(remote.unknownOperations) ? remote.unknownOperations.length > 0 : remote.blockers.length > 0;
      if (!remote.confirmed || hasUnknown || (!chosenEngine && (remote.blockers.length || this.store.all('turns').some(t=>t.workspaceId===w.id&&!t.consumed&&!t.done)))) throw Error('WORKSPACE_NOT_READY');
      const modes = parsed.tool==='workspace_run'?['execute']:parsed.tool==='workspace_write_file'?['edit','execute']:['read','edit','execute'];
      if (!modes.includes(remote.grant.mode)) throw Error('LOCAL_PERMISSION_REQUIRED');
      const supported=remote.sandbox?.supportedTools;
      if (parsed.tool && supported!==undefined && !(Array.isArray(supported)&&supported.includes(parsed.tool))) throw Error('TOOL_UNAVAILABLE_ON_DEVICE');
      binding = Object.fromEntries(['accountId','deviceId','workspaceId','grantVersion'].map(k=>[k,remote.grant[k]]));
    }
    this.store.ensureCapacity(1024*1024);
    if (this.store.all('turns').length >= 2000) throw Error('TURN_LIMIT');
    const publicAtts = resolvedAtts.map(({ id, name, mime, size }) => ({ id, name, mime, size }));
    const result = this.store.tx(()=>{
      const existing = this.store.request(body.requestId,payload); if(existing)return existing;
      if (this.session(s.id).activeTurnId) throw Error('SESSION_BUSY');
      if (!parsed.help && !chosenEngine && this.store.all('turns').some(t=>t.workspaceId===w.id&&!t.done)) throw Error('WORKSPACE_NOT_READY');
      const id = randomUUID(), turn = { id,sessionId:s.id,workspaceId:w.id,createdAt:Date.now(),state:'preparing',done:false,consumed:false,
        ...parsed,historyBefore:s.lastSeq,binding:binding?{...binding,sessionId:s.id,turnId:id,turnEpoch:1}:null };
      this.store.append(s.id,{type:'user_message',text:body.text,...(publicAtts.length?{attachments:publicAtts}:{})});
      if(parsed.help){
        turn.done=true;turn.consumed=true;turn.state='succeeded';
        this.store.append(s.id,{type:'assistant_text',id:randomUUID(),text:parsed.help});this.store.append(s.id,{type:'turn_end',ok:true});
      }else{
        if (parsed.tool) this.store.append(s.id,{type:'tool_call',id,name:parsed.tool,input:parsed.args,status:'running'});
        const current=this.session(s.id);current.activeTurnId=id;this.store.put('sessions',s.id,current);
      }
      this.store.put('turns',id,turn);const reply={sessionId:s.id,workspaceId:w.id,historyEpoch:s.historyEpoch,turnId:id,acceptedSeq:this.session(s.id).lastSeq};this.store.receipt(body.requestId,payload,reply);return reply;
    });
    this.emit('events',s.id);
    const turn=this.store.get('turns',result.turnId);
    if(!turn.done) {
      if (turn.engine === 'codex' || turn.engine === 'antigravity') this.scheduleAiTurn(turn);
      else this.track(this.dispatch(turn));
    }
    return { ...result, activeTurn: this.publicTurn(this.store.get('turns', result.turnId)) };
  }
  scheduleAiTurn(turn) {
    const slot = this.launchLimiter.enqueue(turn.engine, turn.id, {
      onUpdate: info => {
        this.delta(turn.sessionId, {
          kind: 'queue', turnId: turn.id, queued: true,
          position: info.position, remainingMs: info.remainingMs, delayMs: info.delayMs,
        });
        this.emit('state');
      },
    });
    if (!slot.queued) {
      this.track(turn.engine === 'codex' ? this.codex.run(turn) : this.antigravity.run(turn));
      return;
    }
    this.queued.add(turn.id);
    this.store.put('turns', turn.id, { ...turn, state: 'queued' });
    this.delta(turn.sessionId, {
      kind: 'queue', turnId: turn.id, queued: true,
      position: slot.position, remainingMs: slot.remainingMs, delayMs: slot.delayMs,
    });
    this.emit('state');
    this.track((async () => {
      const allowed = await slot.wait;
      this.queued.delete(turn.id);
      let current = this.store.get('turns', turn.id);
      if (!allowed || this.closing || !current || current.cancelRequested || current.done) {
        this.finishQueuedTurn(turn.id);
        return;
      }
      try {
        const w = this.workspace(current.workspaceId);
        const remote = await this.broker(w, 'workspace');
        const hasUnknown = Array.isArray(remote.unknownOperations) ? remote.unknownOperations.length > 0 : false;
        if (!remote.confirmed || hasUnknown || remote.grant.mode === 'revoked') {
          this.finishQueuedTurn(turn.id, remote.grant.mode === 'revoked' ? '项目权限已撤销，排队已取消。' : '设备连接变化，请重新发送。');
          return;
        }
        const nextBinding = current.binding ? { ...current.binding, grantVersion: remote.grant.grantVersion } : null;
        current = { ...current, state: 'preparing', binding: nextBinding };
        this.store.put('turns', turn.id, current);
      } catch {
        this.finishQueuedTurn(turn.id, '设备状态校验失败，请重新发送。');
        return;
      }
      this.delta(turn.sessionId, { kind: 'queue', turnId: turn.id, queued: false, remainingMs: 0 });
      this.emit('state');
      await (current.engine === 'codex' ? this.codex.run(current) : this.antigravity.run(current));
    })());
  }
  finishQueuedTurn(turnId, reason = null) {
    let sessionId = null;
    this.store.tx(() => {
      const t = this.store.get('turns', turnId);
      if (!t || t.consumed) return;
      sessionId = t.sessionId;
      const cancelled = Boolean(t.cancelRequested);
      const state = cancelled ? 'cancelled' : 'interrupted';
      const error = reason ?? (cancelled ? '已取消排队。' : '排队中断，请重新发送。');
      this.store.append(t.sessionId, { type: 'turn_end', ok: false, engine: t.engine, error });
      this.store.put('turns', t.id, { ...t, state, done: true, consumed: true });
      const s = this.session(t.sessionId);
      if (s.activeTurnId === t.id) this.store.put('sessions', s.id, { ...s, activeTurnId: null });
    });
    if (sessionId) {
      this.delta(sessionId, { kind: 'queue', turnId, queued: false, remainingMs: 0 });
      this.emit('events', sessionId);
      this.emit('state');
    }
  }
  track(p) { this.work.add(p);p.catch(e=>console.error('host background:',e.message)).finally(()=>this.work.delete(p));return p; }
  async host(t) {
    if (this.hosts.has(t.id)) return this.hosts.get(t.id);
    const w = this.workspace(t.workspaceId);
    const executor = new WorkspaceExecutor({ journal: this.store, binding: t.binding, control: (m, p) => this.broker(w, m, p) });
    const client = createDirectWorkspaceClient(executor, { waitMs: 250 });
    const h = { client, executor };
    this.hosts.set(t.id, h);
    return h;
  }
  async closeHost(id) {
    const h = this.hosts.get(id);
    if (!h) return;
    this.hosts.delete(id);
    await h.client.close().catch(() => {});
  }
  async dispatch(turn){
    if(this.busy.has(turn.id))return;this.busy.add(turn.id);
    try{
      await this.withWorkspaceLock(turn.workspaceId, async () => {
        const h=await this.host(turn),ticket=await h.executor.issue(turn.id,turn.tool,turn.args);
        turn={...this.store.get('turns',turn.id),operationId:ticket.operationId};this.store.put('turns',turn.id,turn);
        const r=await h.client.callTool({name:turn.tool,arguments:turn.args,_meta:{'anywhere/callTicket':ticket.ticket}},undefined,{timeout:15000});
        await this.capture(this.store.get('turns',turn.id),h,r);
      });
    }catch(e){const t=this.store.get('turns',turn.id);t.error=e.message;this.store.put('turns',t.id,t);}
    finally{this.busy.delete(turn.id);}
  }
  start(){this.timer=setInterval(()=>{for(const t of this.store.all('turns'))if(!t.consumed)this.track(this.refresh(t.id));},600);}
  async refresh(id){
    if(this.closing||this.busy.has(id)||this.queued.has(id)||this.launchLimiter?.isQueued(id))return;this.busy.add(id);
    try{
      let t=this.store.get('turns',id);if(t.consumed)return;
      if (t.engine==='codex') {
        if (this.codex && !this.codex.active.has(id)) await this.codex.reconcile(t);
        return;
      }
      if (t.engine==='antigravity') {
        if (this.antigravity && !this.antigravity.active.has(id)) await this.antigravity.reconcile(t);
        return;
      }
      const h=await this.host(t);
      if(!t.operationId){
        const found=await h.executor.recover(t.id);
        if(!found){this.finishUnsubmitted(t);await this.closeHost(id);return;}
        t={...this.store.get('turns',id),operationId:found.operationId};this.store.put('turns',id,t);
      }
      if(t.cancelRequested)await this.broker(this.workspace(t.workspaceId),'stopTurn',{sessionId:t.sessionId,turnId:t.id,turnEpoch:1});
      await this.capture(t,h,await h.client.callTool({name:'workspace_task_status',arguments:{operationId:t.operationId}}));
    }catch(e){const t=this.store.get('turns',id);t.error=e.message;this.store.put('turns',id,t);}
    finally{this.busy.delete(id);}
  }
  finishUnsubmitted(t){
    this.store.tx(()=>{t={...t,...this.store.get('turns',t.id)};t.state=t.cancelRequested?'cancelled':'interrupted';t.done=true;t.consumed=true;this.store.put('turns',t.id,t);
      this.store.append(t.sessionId,{type:'tool_call',id:t.id,name:t.tool,input:t.args,status:'failed',output:'提交前中断，未发现已准备操作；没有自动重试。'});
      this.store.append(t.sessionId,{type:'turn_end',ok:false,error:'提交前中断'});
      const s=this.session(t.sessionId);if(s.activeTurnId===t.id){s.activeTurnId=null;this.store.put('sessions',s.id,s);}});this.emit('events',t.sessionId);
  }
  async capture(t,h,r){
    const data=r.structuredContent,task=data?.task;if(!task)throw Error(data?.error??'INVALID_TOOL_RESULT');
    const latest=this.store.get('turns',t.id);t.cancelRequested=latest.cancelRequested||task.cancelRequested;
    t.state=task.state;t.error=null;t.outcome=data.result?.executionOutcome;
    const pages=[];let cursor=0;
    while(cursor<task.receivedSeq){const p=await h.executor.output(t.operationId,cursor);if(p.nextSeq<=cursor)throw Error('OUTPUT_NO_PROGRESS');pages.push(p);cursor=p.nextSeq;}
    const output=pages.flatMap(p=>p.rows).map(p=>p.data).join('');
    const text=r.content?.filter(p=>p.type==='text').map(p=>p.text).join('\n')??'';
    const truncated=output.length>12000||pages.some(p=>p.truncatedThrough>0);
    let display=(output||text).slice(-12000);if(truncated)display='[仅显示保留输出的末尾；较早内容已截断]\n'+display;
    if(task.state==='unknown')display+='\n结果未知：请撤销本地权限并核对，任务不会自动重跑。';
    if(task.state==='reviewed')display+='\n本地已核对，执行结果仍为未知。';
    while(Buffer.byteLength(JSON.stringify(display))>8500)display='[输出节选]\n'+display.slice(Math.ceil(display.length/4));
    const event={type:'tool_call',id:t.id,name:t.tool,input:t.args,status:task.resultReady?(task.state==='succeeded'?'completed':'failed'):task.state==='unknown'?'failed':'running',output:display};
    const viewHash=hash({event,state:task.state});
    this.store.tx(()=>{
      t.cancelRequested ||= this.store.get('turns',t.id)?.cancelRequested;
      if(t.viewHash!==viewHash){this.store.append(t.sessionId,event);t.viewHash=viewHash;}
      if(task.resultReady&&!t.receipt){
        t.receipt={receiptId:'session-history:'+t.id,resultDigest:task.resultDigest};
        this.store.put('results',t.id,{...t.receipt,response:r,pages});
        for(const f of data.result?.fileVersions??[]){const path=f.path??t.args.path;this.store.put('revisions',hash({sessionId:t.sessionId,workspaceId:t.workspaceId,path}),f);}
        this.store.append(t.sessionId,{type:'assistant_text',id:randomUUID(),text:task.state==='succeeded'?'模拟宿主已收到并保存国内工作区的执行结果。':task.state==='reviewed'?'已记录本地核对结论，结果仍为未知，没有重新执行。':task.state==='cancelled'?'国内设备已确认任务停止。':`任务结束：${task.state}。请查看工具输出。`});
        this.store.append(t.sessionId,{type:'turn_end',ok:task.state==='succeeded',...(task.state==='succeeded'?{}:{error:task.state==='reviewed'?'已核对，结果未知':task.state==='cancelled'?'已取消':'执行失败'})});
      }
      this.store.put('turns',t.id,t);
    });
    this.emit('events',t.sessionId);
    if(task.resultReady){
      await h.executor.consumeAfterPersist({operationId:t.operationId,...t.receipt});
      this.store.tx(()=>{t.done=true;t.consumed=true;this.store.put('turns',t.id,t);const s=this.session(t.sessionId);if(s.activeTurnId===t.id){s.activeTurnId=null;this.store.put('sessions',s.id,s);}});
      await this.closeHost(t.id);this.emit('events',t.sessionId);
    }
  }
  findQuestionPrompt(sessionId, questionId) {
    let cursor = 0;
    let prompt = null;
    let answered = false;
    let superseded = false;
    while (true) {
      const page = this.store.page(sessionId, cursor);
      if (!page.events.length) break;
      for (const { event } of page.events) {
        if (!prompt) {
          if (event.type === 'question_prompt' && event.id === questionId) prompt = event;
        } else {
          if (event.type === 'question_answer' && event.id === questionId) answered = true;
          else if (event.type === 'user_message') superseded = true;
        }
      }
      if (!page.more || page.throughSeq <= cursor) break;
      cursor = page.throughSeq;
    }
    return { prompt, answered, superseded };
  }
  async answerQuestion(sessionId, body) {
    fields(body, ['requestId', 'questionId'], ['answers', 'skipped']);
    uuid(body.requestId);
    uuid(body.questionId);
    if ('skipped' in body && typeof body.skipped !== 'boolean') throw Error('INVALID_FIELDS');
    const skipped = Boolean(body.skipped);
    const s = this.session(sessionId);
    const payload = { kind: 'answer', sessionId, questionId: body.questionId, skipped };
    const prior = this.store.request(body.requestId, payload);
    if (prior) return prior;

    // 1. Live in-turn question (Codex item/tool/requestUserInput)
    if (this.codex?.hasPendingQuestion?.(body.questionId)) {
      const reply = this.codex.answerQuestion(sessionId, body.questionId, body.answers ?? {}, skipped);
      this.store.receipt(body.requestId, payload, reply);
      return reply;
    }

    // 2. Next-turn question (Antigravity ask_question)
    const { prompt, answered, superseded } = this.findQuestionPrompt(sessionId, body.questionId);
    if (!prompt) throw Error('QUESTION_NOT_FOUND');
    if (answered || superseded) throw Error('QUESTION_ALREADY_ANSWERED');
    if (prompt.mode === 'live') throw Error('QUESTION_EXPIRED');

    const { answers, displayAnswers } = normalizeSubmittedAnswers(prompt.questions, body.answers ?? {}, skipped);
    const promptText = formatAnswersForPrompt(prompt.questions, answers, skipped);
    if (s.activeTurnId) throw Error('SESSION_BUSY');

    const w = this.workspace(s.workspaceId);
    const requestedAgent = prompt.engine ?? s.options?.agent;
    const chosenEngine =
      requestedAgent === 'antigravity' && this.antigravity ? 'antigravity' :
      requestedAgent === 'codex' && this.codex ? 'codex' :
      this.antigravity ? 'antigravity' : this.codex ? 'codex' : null;

    let binding = null;
    if (chosenEngine) {
      const remote = await this.broker(w, 'workspace');
      if (this.config.requireDeviceBinding && (remote.grant.accountId !== s.accountId ||
          remote.grant.deviceId !== s.deviceId || remote.grant.workspaceId !== s.workspaceId)) throw Error('SESSION_TARGET_MISMATCH');
      const concurrentReceipt = this.store.request(body.requestId, payload);
      if (concurrentReceipt) return concurrentReceipt;
      const hasUnknown = Array.isArray(remote.unknownOperations) ? remote.unknownOperations.length > 0 : remote.blockers.length > 0;
      if (!remote.confirmed || hasUnknown) throw Error('WORKSPACE_NOT_READY');
      if (!['read', 'edit', 'execute'].includes(remote.grant.mode)) throw Error('LOCAL_PERMISSION_REQUIRED');
      binding = Object.fromEntries(['accountId', 'deviceId', 'workspaceId', 'grantVersion'].map(k => [k, remote.grant[k]]));
    }

    this.store.ensureCapacity(1024 * 1024);
    if (this.store.all('turns').length >= 2000) throw Error('TURN_LIMIT');

    const result = this.store.tx(() => {
      const existing = this.store.request(body.requestId, payload);
      if (existing) return existing;
      const curSession = this.session(s.id);
      if (curSession.activeTurnId) throw Error('SESSION_BUSY');
      const check = this.findQuestionPrompt(sessionId, body.questionId);
      if (check.answered || check.superseded) throw Error('QUESTION_ALREADY_ANSWERED');
      this.store.append(s.id, {
        type: 'question_answer',
        id: body.questionId,
        engine: chosenEngine ?? prompt.engine ?? 'antigravity',
        skipped,
        answers: displayAnswers,
      });
      if (!chosenEngine) {
        const reply = { ok: true, mode: 'next_turn', sessionId: s.id, questionId: body.questionId, skipped };
        this.store.receipt(body.requestId, payload, reply);
        return reply;
      }
      const id = randomUUID();
      const latestSession = this.session(s.id);
      const turn = {
        id,
        sessionId: s.id,
        workspaceId: w.id,
        createdAt: Date.now(),
        state: 'preparing',
        done: false,
        consumed: false,
        engine: chosenEngine,
        text: promptText,
        attachments: [],
        calls: [],
        historyBefore: latestSession.lastSeq,
        binding: { ...binding, sessionId: s.id, turnId: id, turnEpoch: 1 },
      };
      latestSession.activeTurnId = id;
      this.store.put('sessions', s.id, latestSession);
      this.store.put('turns', id, turn);
      const reply = {
        ok: true,
        mode: 'next_turn',
        sessionId: s.id,
        workspaceId: w.id,
        historyEpoch: latestSession.historyEpoch,
        questionId: body.questionId,
        skipped,
        turnId: id,
        acceptedSeq: latestSession.lastSeq,
      };
      this.store.receipt(body.requestId, payload, reply);
      return reply;
    });

    this.emit('events', s.id);
    if (result.turnId) {
      const turn = this.store.get('turns', result.turnId);
      if (turn && !turn.done) this.scheduleAiTurn(turn);
      return { ...result, activeTurn: this.publicTurn(this.store.get('turns', result.turnId)) };
    }
    this.emit('state');
    return result;
  }
  async stop(sessionId,body){
    fields(body,['requestId','turnId']);uuid(body.requestId);uuid(body.turnId);
    this.session(sessionId);const payload={kind:'stop',sessionId,turnId:body.turnId},prior=this.store.request(body.requestId,payload);if(prior)return prior;
    const t=this.store.get('turns',body.turnId);if(!t||t.sessionId!==sessionId)throw Error('TURN_NOT_BOUND');
    const result={requested:true,turnId:t.id};
    this.store.tx(()=>{if(!t.done)t.cancelRequested=true;this.store.put('turns',t.id,t);this.store.receipt(body.requestId,payload,result);});
    if(!t.done) {
      if (this.launchLimiter?.cancel(t.id)) {
        this.queued.delete(t.id);
        this.finishQueuedTurn(t.id);
        return result;
      }
      if (t.engine==='codex') await this.codex?.interrupt(t.id);
      else if (t.engine==='antigravity') await this.antigravity?.interrupt(t.id);
      else await this.broker(this.workspace(t.workspaceId),'stopTurn',{sessionId,turnId:t.id,turnEpoch:1});
    }
    return result;
  }
  async close(){this.closing=true;clearInterval(this.timer);for(const id of [...this.queued])this.launchLimiter?.cancel(id);if(this.ownsLimiter)this.launchLimiter?.close();await this.codex?.close();await this.antigravity?.close();await Promise.allSettled([...this.work]);for(const id of [...this.hosts.keys()])await this.closeHost(id);this.store.close();}
}
