import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { db } from './db.js';

export const COOKIE_NAME = 'ac_session';

export interface User {
  id: number;
  username: string;
  /** Admins manage accounts, read the machine's CLI history and restart the service. */
  isAdmin: boolean;
}

interface UserRow {
  id: number;
  username: string;
  is_admin: number;
}

const toUser = (r: UserRow): User => ({ id: r.id, username: r.username, isAdmin: !!r.is_admin });

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

// A fixed hash so unknown usernames take as long to reject as wrong passwords.
const dummyHash = hashPassword(randomBytes(16).toString('hex'));

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function checkCredentials(username: string, password: string): User | null {
  const row = db.prepare('SELECT id, username, is_admin, password_hash FROM users WHERE username = ?').get(username) as
    | (UserRow & { password_hash: string })
    | undefined;
  const ok = verifyPassword(password, row?.password_hash ?? dummyHash);
  return ok && row ? toUser(row) : null;
}

/** Whether `password` is the account's current password (for changing it). */
export function checkPassword(userId: number, password: string): boolean {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
  return verifyPassword(password, row?.password_hash ?? dummyHash) && !!row;
}

export function createAuthSession(userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, userId);
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now,
    now + config.sessionTtlMs,
  );
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now);
  return token;
}

export function destroyAuthSession(token: string | undefined) {
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
}

export function userFromToken(token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.is_admin FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), Date.now()) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function userCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

// ---- accounts (added by an admin or the CLI; there is no sign-up) ----

export const MIN_PASSWORD = 8;

/** Why a username cannot be used, or null. */
export function usernameProblem(name: string): string | null {
  // Members' folders are named after them: no leading dot (hidden folders, "..").
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.@-]{1,31}$/u.test(name)) return '用户名 2–32 个字符，以字母、数字或汉字开头，只能用字母、数字、汉字和 _ . @ -';
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(name)) return `用户名 ${name} 已经存在`;
  return null;
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `密码至少 ${MIN_PASSWORD} 位`;
  if (password.length > 200) return '密码太长';
  return null;
}

export function getUser(id: number): User | null {
  const row = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function findUser(username: string): User | null {
  const row = db.prepare('SELECT id, username, is_admin FROM users WHERE username = ?').get(username) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function createUser(username: string, password: string, isAdmin: boolean): User {
  const r = db
    .prepare('INSERT INTO users (username, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), Date.now(), isAdmin ? 1 : 0);
  return getUser(Number(r.lastInsertRowid))!;
}

/**
 * Sets a new password and signs the account out everywhere, except the login
 * whose token is `keepToken` (someone changing their own password stays signed in).
 */
export function setPassword(userId: number, password: string, keepToken?: string) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepToken ? sha256(keepToken) : '');
}

export function setAdmin(userId: number, isAdmin: boolean) {
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
}

export function adminCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n;
}

/** Removes the account; its logins, push devices and sessions go with it (foreign keys). */
export function deleteUser(userId: number) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// ---- Login throttling: 5 failures per 15 minutes per IP and per username. ----
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map<string, number[]>();

function recent(key: string): number[] {
  const now = Date.now();
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(key, list);
  return list;
}

export function isThrottled(ip: string, username: string): boolean {
  return recent(`ip:${ip}`).length >= MAX_FAILURES || recent(`user:${username}`).length >= MAX_FAILURES;
}

export function recordFailure(ip: string, username: string) {
  recent(`ip:${ip}`).push(Date.now());
  recent(`user:${username}`).push(Date.now());
}

/** The same limit for other secrets (share passwords), counted per key. */
export function isThrottledKey(...keys: string[]): boolean {
  return keys.some((k) => recent(k).length >= MAX_FAILURES);
}

export function recordFailureKey(...keys: string[]) {
  for (const k of keys) recent(k).push(Date.now());
}

export function clientIp(req: FastifyRequest): string {
  return (req.headers['cf-connecting-ip'] as string) || req.ip;
}

export function isSecureRequest(req: FastifyRequest): boolean {
  return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const user = userFromToken(req.cookies[COOKIE_NAME]);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  req.user = user;
}

/** After requireAuth: only admins get through. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user?.isAdmin) return reply.code(403).send({ error: '只有管理员可以这样做' });
}

/** Rejects cross-site WebSocket upgrades (browsers send cookies with them). */
export function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
