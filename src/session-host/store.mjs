import { randomUUID } from 'node:crypto';
import { Journal } from '../execution/journal.mjs';
import { hash } from '../execution/protocol.mjs';
import {
  MEMORY_LIMITS,
  memoryEntryBytes,
  normalizeMemoryContent,
  normalizeMemoryKey,
  normalizeMemoryScope,
  resolveScopeId,
} from './memory.mjs';

export const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) throw Error('INVALID_ID'); return value; };
export function fields(value, keys, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_FIELDS');
  const allowed = new Set([...keys, ...optional]);
  if (Object.keys(value).some(k => !allowed.has(k)) || keys.some(k => !Object.hasOwn(value, k))) throw Error('INVALID_FIELDS');
}
export function text(value, max = 65536) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('INVALID_TEXT'); return value; }
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const AGENTS = new Set(['codex', 'antigravity']);
export function validateOptions(options) {
  if (options === undefined) return {};
  fields(options, [], ['agent', 'model', 'effort']);
  const out = {};
  if ('agent' in options) {
    if (options.agent !== null && (typeof options.agent !== 'string' || !AGENTS.has(options.agent))) throw Error('INVALID_FIELDS');
    out.agent = options.agent ?? null;
  }
  if ('model' in options) {
    if (options.model !== null && (typeof options.model !== 'string' || !options.model.trim() || options.model.length > 100)) throw Error('INVALID_FIELDS');
    out.model = options.model ? options.model.trim() : null;
  }
  if ('effort' in options) {
    if (options.effort !== null && (typeof options.effort !== 'string' || !EFFORTS.has(options.effort))) throw Error('INVALID_FIELDS');
    out.effort = options.effort ?? null;
  }
  return out;
}

export class SessionStore extends Journal {
  constructor(path) {
    super(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS chat_events(session_id TEXT,seq INTEGER,ts INTEGER,event TEXT,PRIMARY KEY(session_id,seq))');
    this.db.exec(`CREATE TABLE IF NOT EXISTS memories(
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      mem_key TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(scope, scope_id, mem_key)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS turn_calls(
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      call_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      effective_tool TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      args_summary TEXT NOT NULL,
      operation_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      ok INTEGER,
      consumed INTEGER NOT NULL DEFAULT 0,
      counted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(turn_id, call_id)
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_turn_calls_turn_seq ON turn_calls(turn_id, seq)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_turn_calls_session ON turn_calls(session_id)');
  }
  session(id) { uuid(id); const s = this.get('sessions', id); if (!s) throw Error('SESSION_NOT_FOUND'); return s; }
  request(id, payload) {
    uuid(id); const r = this.get('requests', id);
    if (r && r.digest !== hash(payload)) throw Error('REQUEST_CONFLICT');
    return r?.result;
  }
  receipt(id, payload, result) { this.put('requests', id, { digest: hash(payload), result }); }
  create({ requestId, workspaceId, title, options }, target) {
    uuid(requestId); uuid(workspaceId); text(title, 80);
    const cleanOptions = validateOptions(options);
    const identity = target ? { accountId: target.accountId, deviceId: target.deviceId } : {};
    const payload = { kind: 'create', workspaceId, title, ...(Object.keys(cleanOptions).length ? { options: cleanOptions } : {}), ...identity };
    const prior = this.request(requestId, payload);
    if (prior) return prior;
    this.ensureCapacity(512 * 1024);
    if (this.all('sessions').length >= 500) throw Error('SESSION_LIMIT');
    return this.tx(() => {
      const s = { id: randomUUID(), workspaceId, ...identity, title, options: { agent: null, model: null, effort: null, ...cleanOptions },
        createdAt: Date.now(), updatedAt: Date.now(), historyEpoch: randomUUID(), lastSeq: 0, activeTurnId: null };
      this.put('sessions', s.id, s); this.receipt(requestId, payload, s); return s;
    });
  }
  rename(sessionId, title) {
    text(title, 80);
    return this.tx(() => {
      const s = this.session(sessionId);
      const next = { ...s, title: title.trim(), updatedAt: Date.now() };
      this.put('sessions', s.id, next);
      return next;
    });
  }
  updateOptions(sessionId, options) {
    const clean = validateOptions(options);
    return this.tx(() => {
      const s = this.session(sessionId);
      const next = { ...s, options: { agent: null, model: null, effort: null, ...(s.options ?? {}), ...clean }, updatedAt: Date.now() };
      this.put('sessions', s.id, next);
      return next;
    });
  }
  remove(sessionId) {
    return this.tx(() => {
      const s = this.session(sessionId);
      if (s.activeTurnId) throw Error('SESSION_BUSY');
      this.db.prepare('DELETE FROM chat_events WHERE session_id=?').run(sessionId);
      this.db.prepare('DELETE FROM turn_calls WHERE session_id=?').run(sessionId);
      this.db.prepare("DELETE FROM records WHERE bucket='sessions' AND key=?").run(sessionId);
      this.db.prepare("DELETE FROM archive_records WHERE bucket='sessions' AND key=?").run(sessionId);
      for (const att of this.attachments(sessionId)) {
        this.db.prepare("DELETE FROM records WHERE bucket='attachments' AND key=?").run(sessionId + ':' + att.id);
      }
      return s;
    });
  }
  addAttachment(sessionId, att) {
    this.session(sessionId);
    this.ensureCapacity(262144);
    this.put('attachments', sessionId + ':' + att.id, { ...att, sessionId });
    return att;
  }
  attachment(sessionId, attId) {
    uuid(attId);
    const att = this.get('attachments', sessionId + ':' + attId);
    if (!att || att.sessionId !== sessionId) throw Error('ATTACHMENT_NOT_FOUND');
    return att;
  }
  attachments(sessionId) {
    return this.all('attachments').filter(a => a.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
  }
  append(sessionId, event) {
    const s = this.session(sessionId), row = { seq: s.lastSeq + 1, ts: Date.now(), event };
    if (Buffer.byteLength(JSON.stringify(row)) > 131072) throw Error('EVENT_TOO_LARGE');
    this.db.prepare('INSERT INTO chat_events VALUES(?,?,?,?)').run(sessionId, row.seq, row.ts, JSON.stringify(event));
    s.lastSeq = row.seq; s.updatedAt = row.ts; this.put('sessions', s.id, s); return row;
  }
  page(sessionId, afterSeq = 0) {
    const s = this.session(sessionId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > s.lastSeq) throw Error('INVALID_CURSOR');
    const events = []; let bytes = 0;
    for (const row of this.db.prepare('SELECT seq,ts,event FROM chat_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 50').all(sessionId, afterSeq)) {
      const next = { seq: Number(row.seq), ts: Number(row.ts), event: JSON.parse(row.event) }, size = Buffer.byteLength(JSON.stringify(next));
      if (events.length && bytes + size > 96000) break;
      events.push(next); bytes += size;
    }
    const throughSeq = events.at(-1)?.seq ?? afterSeq;
    return { sessionId, workspaceId: s.workspaceId, historyEpoch: s.historyEpoch, events, throughSeq, more: throughSeq < s.lastSeq };
  }
  pageBefore(sessionId, beforeSeq, { maxMessages = 16 } = {}) {
    const s = this.session(sessionId);
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1) throw Error('INVALID_CURSOR');
    const upper = Math.min(beforeSeq, s.lastSeq + 1);
    const isRenderable = ev => Boolean(
      ev && (
        ev.type === 'user_message' ||
        ev.type === 'assistant_text' ||
        ev.type === 'tool_call' ||
        ev.type === 'context_compacted' ||
        ev.type === 'turn_notice' ||
        (ev.type === 'thinking' && ev.text) ||
        (ev.type === 'turn_end' && (!ev.ok || ev.model || ev.durationMs || ev.usage?.inputTokens || ev.usage?.outputTokens))
      ),
    );
    const rev = [];
    let bytes = 0, messages = 0, lastAssistantGroup = null, hasRenderable = false;
    for (const row of this.db.prepare('SELECT seq,ts,event FROM chat_events WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT 240').all(sessionId, upper)) {
      const parsed = JSON.parse(row.event);
      const next = { seq: Number(row.seq), ts: Number(row.ts), event: parsed };
      const size = Buffer.byteLength(JSON.stringify(next));
      if (rev.length && hasRenderable && bytes + size > 128000) break;
      if (rev.length && bytes + size > 512000) break;
      rev.push(next); bytes += size;
      if (isRenderable(parsed)) hasRenderable = true;
      if (parsed.type === 'user_message') {
        messages++;
        lastAssistantGroup = null;
        if (messages >= maxMessages) break;
      } else if (parsed.type === 'assistant_text') {
        const grp = String(parsed.id ?? row.seq).replace(/-\d+$/, '');
        if (grp !== lastAssistantGroup) {
          messages++;
          lastAssistantGroup = grp;
        }
      } else {
        lastAssistantGroup = null;
      }
    }
    const events = rev.reverse();
    const firstSeq = events[0]?.seq ?? upper;
    const throughSeq = events.at(-1)?.seq ?? Math.max(0, upper - 1);
    return { sessionId, workspaceId: s.workspaceId, historyEpoch: s.historyEpoch, events, firstSeq, throughSeq, hasMore: firstSeq > 1 };
  }
  listMemories(scope, workspaceId = null) {
    const cleanScope = normalizeMemoryScope(scope);
    const scopeId = resolveScopeId(cleanScope, workspaceId);
    const limits = MEMORY_LIMITS[cleanScope];
    const rows = this.db.prepare(
      'SELECT mem_key, content, updated_at FROM memories WHERE scope=? AND scope_id=? ORDER BY updated_at DESC, mem_key ASC',
    ).all(cleanScope, scopeId);
    let usedBytes = 0;
    const items = rows.map(row => {
      const entry = { key: row.mem_key, content: row.content, updatedAt: Number(row.updated_at) };
      usedBytes += memoryEntryBytes(entry);
      return entry;
    });
    return {
      scope: cleanScope,
      workspaceId: cleanScope === 'workspace' ? scopeId : null,
      items,
      count: items.length,
      usedBytes,
      limits,
    };
  }
  upsertMemory(scope, workspaceId, { key, content }) {
    const cleanScope = normalizeMemoryScope(scope);
    const scopeId = resolveScopeId(cleanScope, workspaceId);
    const cleanKey = normalizeMemoryKey(key);
    const cleanContent = normalizeMemoryContent(cleanScope, content);
    const limits = MEMORY_LIMITS[cleanScope];
    return this.tx(() => {
      const existing = this.db.prepare(
        'SELECT mem_key, content FROM memories WHERE scope=? AND scope_id=?',
      ).all(cleanScope, scopeId);
      const prior = existing.find(row => row.mem_key === cleanKey);
      if (!prior && existing.length >= limits.maxItems) throw Error('MEMORY_LIMIT_REACHED');
      let totalBytes = memoryEntryBytes({ key: cleanKey, content: cleanContent });
      for (const row of existing) {
        if (row.mem_key !== cleanKey) totalBytes += memoryEntryBytes({ key: row.mem_key, content: row.content });
      }
      if (totalBytes > limits.maxTotalBytes) throw Error('MEMORY_STORAGE_LIMIT');
      this.ensureCapacity(65536);
      const updatedAt = Date.now();
      this.db.prepare(
        `INSERT INTO memories(scope, scope_id, mem_key, content, updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(scope, scope_id, mem_key) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
      ).run(cleanScope, scopeId, cleanKey, cleanContent, updatedAt);
      const count = prior ? existing.length : existing.length + 1;
      return {
        scope: cleanScope,
        workspaceId: cleanScope === 'workspace' ? scopeId : null,
        item: { key: cleanKey, content: cleanContent, updatedAt },
        count,
        usedBytes: totalBytes,
        limits,
      };
    });
  }
  deleteMemory(scope, workspaceId, key) {
    const cleanScope = normalizeMemoryScope(scope);
    const scopeId = resolveScopeId(cleanScope, workspaceId);
    const cleanKey = normalizeMemoryKey(key);
    const deleted = this.db.prepare(
      'DELETE FROM memories WHERE scope=? AND scope_id=? AND mem_key=?',
    ).run(cleanScope, scopeId, cleanKey).changes > 0;
    return {
      scope: cleanScope,
      workspaceId: cleanScope === 'workspace' ? scopeId : null,
      key: cleanKey,
      deleted,
    };
  }
  clearMemories(scope, workspaceId = null) {
    const cleanScope = normalizeMemoryScope(scope);
    const scopeId = resolveScopeId(cleanScope, workspaceId);
    const cleared = Number(this.db.prepare(
      'DELETE FROM memories WHERE scope=? AND scope_id=?',
    ).run(cleanScope, scopeId).changes ?? 0);
    return {
      scope: cleanScope,
      workspaceId: cleanScope === 'workspace' ? scopeId : null,
      cleared,
    };
  }
  purgeWorkspaceMemories(workspaceId) {
    const id = uuid(workspaceId);
    return Number(this.db.prepare(
      "DELETE FROM memories WHERE scope='workspace' AND scope_id=?",
    ).run(id).changes ?? 0);
  }
  deleteRecord(bucket, key) {
    this.db.prepare('DELETE FROM records WHERE bucket=? AND key=?').run(bucket, key);
    this.db.prepare('DELETE FROM archive_records WHERE bucket=? AND key=?').run(bucket, key);
  }
  parseTurnCallRow(row) {
    if (!row) return null;
    let argsSummary = {};
    try { argsSummary = JSON.parse(row.args_summary); } catch {}
    return {
      turnId: row.turn_id,
      sessionId: row.session_id,
      seq: Number(row.seq),
      callId: row.call_id,
      tool: row.tool,
      effectiveTool: row.effective_tool,
      inputHash: row.input_hash,
      argsSummary,
      operationId: row.operation_id ?? null,
      state: row.state,
      ok: row.ok === null || row.ok === undefined ? null : Boolean(row.ok),
      consumed: Boolean(row.consumed),
      counted: Boolean(row.counted),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  getTurnCall(turnId, callId) {
    const row = this.db.prepare(
      'SELECT * FROM turn_calls WHERE turn_id=? AND call_id=?',
    ).get(turnId, callId);
    return this.parseTurnCallRow(row);
  }
  listTurnCalls(turnId, { onlyUnconsumed = false } = {}) {
    const sql = onlyUnconsumed
      ? 'SELECT * FROM turn_calls WHERE turn_id=? AND consumed=0 ORDER BY seq ASC'
      : 'SELECT * FROM turn_calls WHERE turn_id=? ORDER BY seq ASC';
    return this.db.prepare(sql).all(turnId).map(row => this.parseTurnCallRow(row));
  }
  hasTurnCalls(turnId) {
    return Boolean(this.db.prepare('SELECT 1 FROM turn_calls WHERE turn_id=? LIMIT 1').get(turnId));
  }
  upsertTurnCall({
    turnId, sessionId, callId, tool, effectiveTool, inputHash, argsSummary,
    operationId = null, state = 'pending', ok = null, consumed = false, counted = false,
  }) {
    const existing = this.getTurnCall(turnId, callId);
    if (existing) return existing;
    const now = Date.now();
    const nextSeq = Number(this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM turn_calls WHERE turn_id=?',
    ).get(turnId).n);
    this.db.prepare(
      `INSERT INTO turn_calls(
         turn_id, session_id, seq, call_id, tool, effective_tool, input_hash,
         args_summary, operation_id, state, ok, consumed, counted, created_at, updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      turnId, sessionId, nextSeq, callId, tool, effectiveTool ?? tool, inputHash,
      JSON.stringify(argsSummary ?? {}), operationId, state,
      ok === null || ok === undefined ? null : (ok ? 1 : 0),
      consumed ? 1 : 0, counted ? 1 : 0, now, now,
    );
    return this.getTurnCall(turnId, callId);
  }
  updateTurnCall(turnId, callId, patch = {}) {
    const sets = [];
    const params = [];
    if ('operationId' in patch) { sets.push('operation_id=?'); params.push(patch.operationId ?? null); }
    if ('state' in patch) { sets.push('state=?'); params.push(patch.state); }
    if ('ok' in patch) { sets.push('ok=?'); params.push(patch.ok === null || patch.ok === undefined ? null : (patch.ok ? 1 : 0)); }
    if ('consumed' in patch) { sets.push('consumed=?'); params.push(patch.consumed ? 1 : 0); }
    if ('counted' in patch) { sets.push('counted=?'); params.push(patch.counted ? 1 : 0); }
    if (!sets.length) return this.getTurnCall(turnId, callId);
    sets.push('updated_at=?');
    params.push(Date.now(), turnId, callId);
    this.db.prepare(`UPDATE turn_calls SET ${sets.join(', ')} WHERE turn_id=? AND call_id=?`).run(...params);
    return this.getTurnCall(turnId, callId);
  }
}
