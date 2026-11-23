import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, SESSION_TTL_MS } from './auth-db.mjs';

export const MIN_PASSWORD = 8;
const toUser = r => ({ id: r.id, username: r.username, isAdmin: !!r.is_admin });
const sha256 = s => createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

// Fixed dummy hash so unknown usernames take the same scrypt time as wrong passwords.
const dummyHash = hashPassword(randomBytes(16).toString('hex'));

export function checkCredentials(username, password) {
  const row = db.prepare('SELECT id, username, is_admin, password_hash FROM users WHERE username = ?').get(username);
  const ok = verifyPassword(password, row?.password_hash ?? dummyHash);
  return ok && row ? toUser(row) : null;
}

export function checkPassword(userId, password) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  return verifyPassword(password, row?.password_hash ?? dummyHash) && !!row;
}

export function createAuthSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, userId);
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token), userId, now, now + SESSION_TTL_MS,
  );
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now);
  return token;
}

export function destroyAuthSession(token) {
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.is_admin FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(sha256(token), Date.now());
  return row ? toUser(row) : null;
}

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function usernameProblem(name) {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.@-]{1,31}$/u.test(name)) return '用户名 2–32 个字符，以字母、数字或汉字开头，只能用字母、数字、汉字和 _ . @ -';
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(name)) return `用户名 ${name} 已经存在`;
  return null;
}

export function passwordProblem(password) {
  if (password.length < MIN_PASSWORD) return `密码至少 ${MIN_PASSWORD} 位`;
  if (password.length > 200) return '密码太长';
  return null;
}

export function getUser(id) {
  const row = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(id);
  return row ? toUser(row) : null;
}

export function findUser(username) {
  const row = db.prepare('SELECT id, username, is_admin FROM users WHERE username = ?').get(username);
  return row ? toUser(row) : null;
}

export function createUser(username, password, isAdmin) {
  const r = db.prepare('INSERT INTO users (username, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?)').run(
    username, hashPassword(password), Date.now(), isAdmin ? 1 : 0,
  );
  return getUser(Number(r.lastInsertRowid));
}

export function setPassword(userId, password, keepToken) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepToken ? sha256(keepToken) : '');
}

export function setAdmin(userId, isAdmin) {
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
}

export function adminCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n;
}

export function deleteUser(userId) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// Login throttling: 5 failures per 15 minutes per IP and per username.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map();

function recent(key) {
  const now = Date.now();
  const list = (failures.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  failures.set(key, list);
  return list;
}

export function isThrottled(ip, username) {
  return recent(`ip:${ip}`).length >= MAX_FAILURES || recent(`user:${username}`).length >= MAX_FAILURES;
}

export function recordFailure(ip, username) {
  recent(`ip:${ip}`).push(Date.now());
  recent(`user:${username}`).push(Date.now());
}

export function isThrottledKey(...keys) {
  return keys.some(k => recent(k).length >= MAX_FAILURES);
}

export function recordFailureKey(...keys) {
  for (const k of keys) recent(k).push(Date.now());
}
