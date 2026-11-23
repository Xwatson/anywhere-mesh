import { randomUUID } from 'node:crypto';
import { Journal } from '../execution/journal.mjs';
import { hash } from '../execution/protocol.mjs';

export const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) throw Error('INVALID_ID'); return value; };
export function fields(value, keys, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_FIELDS');
  const allowed = new Set([...keys, ...optional]);
  if (Object.keys(value).some(k => !allowed.has(k)) || keys.some(k => !Object.hasOwn(value, k))) throw Error('INVALID_FIELDS');
}
export function text(value, max = 65536) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('INVALID_TEXT'); return value; }
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export function validateOptions(options) {
  if (options === undefined) return {};
  fields(options, [], ['model', 'effort']);
  const out = {};
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
      const s = { id: randomUUID(), workspaceId, ...identity, title, options: { model: null, effort: null, ...cleanOptions },
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
      const next = { ...s, options: { model: null, effort: null, ...(s.options ?? {}), ...clean }, updatedAt: Date.now() };
      this.put('sessions', s.id, next);
      return next;
    });
  }
  remove(sessionId) {
    return this.tx(() => {
      const s = this.session(sessionId);
      if (s.activeTurnId) throw Error('SESSION_BUSY');
      this.db.prepare('DELETE FROM chat_events WHERE session_id=?').run(sessionId);
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
  pageBefore(sessionId, beforeSeq) {
    const s = this.session(sessionId);
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1 || beforeSeq > s.lastSeq + 1) throw Error('INVALID_CURSOR');
    const rev = []; let bytes = 0;
    for (const row of this.db.prepare('SELECT seq,ts,event FROM chat_events WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT 50').all(sessionId, beforeSeq)) {
      const next = { seq: Number(row.seq), ts: Number(row.ts), event: JSON.parse(row.event) }, size = Buffer.byteLength(JSON.stringify(next));
      if (rev.length && bytes + size > 96000) break;
      rev.push(next); bytes += size;
    }
    const events = rev.reverse();
    const firstSeq = events[0]?.seq ?? beforeSeq;
    return { sessionId, workspaceId: s.workspaceId, historyEpoch: s.historyEpoch, events, firstSeq, hasMore: firstSeq > 1 };
  }
}
