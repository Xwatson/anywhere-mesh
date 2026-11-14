import { createHmac, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.js';
import { db } from './db.js';
import type { ShareInfo } from './shared/protocol.js';

/** How long a new link stays valid unless the user picks another time, and the longest allowed. */
export const SHARE_DEFAULT_HOURS = 24;
export const SHARE_MAX_HOURS = 7 * 24;

export const SHARE_PASSWORD_MIN = 4;
export const SHARE_PASSWORD_MAX = 64;

export interface ShareRow {
  id: string;
  session_id: string;
  password_hash: string | null;
  upto_seq: number | null;
  created_at: number;
  expires_at: number;
}

const toInfo = (r: ShareRow): ShareInfo => ({
  id: r.id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  hasPassword: !!r.password_hash,
  live: r.upto_seq === null,
});

/** Expired links are deleted, not kept around. */
function sweep() {
  db.prepare('DELETE FROM session_shares WHERE expires_at <= ?').run(Date.now());
}

/** The session's links that still work, newest first. */
export function listShares(sessionId: string): ShareInfo[] {
  sweep();
  const rows = db.prepare('SELECT * FROM session_shares WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as unknown as ShareRow[];
  return rows.map(toInfo);
}

/** Why the share settings cannot be used, or null. */
export function shareProblem(hours: number, password: string): string | null {
  if (!Number.isInteger(hours) || hours < 1 || hours > SHARE_MAX_HOURS) return `有效期 1 小时到 ${SHARE_MAX_HOURS / 24} 天`;
  if (password && (password.length < SHARE_PASSWORD_MIN || password.length > SHARE_PASSWORD_MAX)) {
    return `密码 ${SHARE_PASSWORD_MIN}–${SHARE_PASSWORD_MAX} 位，不要密码就留空`;
  }
  return null;
}

/**
 * A new link to the session. `live`: viewers also see what happens afterwards;
 * otherwise the link shows the conversation up to now.
 */
export function createShare(sessionId: string, opts: { hours: number; password: string; live: boolean }): ShareInfo {
  sweep();
  const now = Date.now();
  const upto = opts.live
    ? null
    : ((db.prepare('SELECT MAX(seq) AS m FROM events WHERE session_id = ?').get(sessionId) as { m: number | null }).m ?? 0);
  // 144 random bits: the link itself is the key to the conversation.
  const id = randomBytes(18).toString('base64url');
  db.prepare(
    'INSERT INTO session_shares (id, session_id, password_hash, upto_seq, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, sessionId, opts.password ? hashPassword(opts.password) : null, upto, now, now + opts.hours * 3600_000);
  return toInfo(db.prepare('SELECT * FROM session_shares WHERE id = ?').get(id) as unknown as ShareRow);
}

/** Revokes a link of the session; false when it had no such link. */
export function deleteShare(sessionId: string, id: string): boolean {
  return db.prepare('DELETE FROM session_shares WHERE id = ? AND session_id = ?').run(id, sessionId).changes > 0;
}

/** The link, if it exists and has not expired. */
export function findShare(id: string): ShareRow | null {
  if (!/^[\w-]{16,64}$/.test(id)) return null;
  const row = db.prepare('SELECT * FROM session_shares WHERE id = ? AND expires_at > ?').get(id, Date.now()) as unknown as
    | ShareRow
    | undefined;
  return row ?? null;
}

export function checkSharePassword(share: ShareRow, password: string): boolean {
  return !!share.password_hash && verifyPassword(password, share.password_hash);
}

/**
 * What the viewer's cookie holds once the password was given: derived from the stored
 * (salted, secret) hash, so it needs no storage and stops working with the link.
 */
export function shareAccessKey(share: ShareRow): string {
  return createHmac('sha256', share.password_hash ?? '').update(`share:${share.id}`).digest('base64url');
}

/** Whether the link's password, if any, was given (the cookie set when it was). */
export function canRead(share: ShareRow, cookie: string | undefined): boolean {
  return !share.password_hash || cookie === shareAccessKey(share);
}

/** Whether an attachment was sent in the part of the conversation the link shows. */
export function sharedAttachment(share: ShareRow, file: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM events e, json_each(e.payload, '$.event.attachments') a
       WHERE e.session_id = ? AND e.seq <= ? AND json_extract(e.payload, '$.event.type') = 'user_message'
         AND json_extract(a.value, '$.id') = ? LIMIT 1`,
    )
    .get(share.session_id, share.upto_seq ?? Number.MAX_SAFE_INTEGER, file);
}
