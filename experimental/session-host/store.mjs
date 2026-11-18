import { randomUUID } from 'node:crypto';
import { Journal } from '../execution/journal.mjs';
import { hash } from '../execution/protocol.mjs';

export const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) throw Error('INVALID_ID'); return value; };
export function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) throw Error('INVALID_FIELDS');
}
export function text(value, max = 8192) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('INVALID_TEXT'); return value; }

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
  create({ requestId, workspaceId, title }, target) {
    uuid(requestId); uuid(workspaceId); text(title, 80);
    const identity = target ? { accountId: target.accountId, deviceId: target.deviceId } : {};
    const payload = { kind: 'create', workspaceId, title, ...identity }, prior = this.request(requestId, payload);
    if (prior) return prior;
    this.ensureCapacity(512 * 1024);
    if (this.all('sessions').length >= 50) throw Error('SESSION_LIMIT');
    return this.tx(() => {
      const s = { id: randomUUID(), workspaceId, ...identity, title, createdAt: Date.now(), updatedAt: Date.now(), historyEpoch: randomUUID(), lastSeq: 0, activeTurnId: null };
      this.put('sessions', s.id, s); this.receipt(requestId, payload, s); return s;
    });
  }
  append(sessionId, event) {
    const s = this.session(sessionId), row = { seq: s.lastSeq + 1, ts: Date.now(), event };
    if (Buffer.byteLength(JSON.stringify(row)) > 28000) throw Error('EVENT_TOO_LARGE');
    this.db.prepare('INSERT INTO chat_events VALUES(?,?,?,?)').run(sessionId, row.seq, row.ts, JSON.stringify(event));
    s.lastSeq = row.seq; s.updatedAt = row.ts; this.put('sessions', s.id, s); return row;
  }
  page(sessionId, afterSeq = 0) {
    const s = this.session(sessionId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > s.lastSeq) throw Error('INVALID_CURSOR');
    const events = []; let bytes = 0;
    for (const row of this.db.prepare('SELECT seq,ts,event FROM chat_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 50').all(sessionId, afterSeq)) {
      const next = { seq: Number(row.seq), ts: Number(row.ts), event: JSON.parse(row.event) }, size = Buffer.byteLength(JSON.stringify(next));
      if (bytes + size > 32000) break;
      events.push(next); bytes += size;
    }
    const throughSeq = events.at(-1)?.seq ?? afterSeq;
    return { sessionId, workspaceId: s.workspaceId, historyEpoch: s.historyEpoch, events, throughSeq, more: throughSeq < s.lastSeq };
  }
}
