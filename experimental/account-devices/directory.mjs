import { createHash, randomUUID } from 'node:crypto';
import { db } from '../../server/dist/db.js';
import { checkCredentials, checkPassword, createAuthSession, destroyAuthSession, isThrottled, isThrottledKey,
  passwordProblem, recordFailure, recordFailureKey, setPassword, userFromToken } from '../../server/dist/auth.js';
import { fields, text, uuid } from '../session-host/store.mjs';
import contract from './contract.cjs';

const digest = value => createHash('sha256').update(value).digest('hex');

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_devices (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    installation_hash TEXT NOT NULL, name TEXT NOT NULL, last_seen INTEGER, disabled INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, installation_hash)
  );
  CREATE TABLE IF NOT EXISTS mcp_logins (
    token_hash TEXT PRIMARY KEY REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
    device_id TEXT REFERENCES mcp_devices(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS mcp_workspaces (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES mcp_devices(id) ON DELETE CASCADE,
    local_id TEXT NOT NULL, label TEXT NOT NULL, UNIQUE(device_id, local_id)
  );
`);
const upsertWorkspace = db.prepare(`INSERT INTO mcp_workspaces VALUES(?,?,?,?)
  ON CONFLICT(device_id,local_id) DO UPDATE SET label=excluded.label
  RETURNING id, device_id AS deviceId, local_id AS localId, label`);

function validateWorkspace(p) { fields(p,['localId','label']); uuid(p.localId); text(p.label,80); }

export function login(input, ip) {
  const native = Object.hasOwn(input ?? {}, 'installation');
  fields(input, native ? ['username','password','installation','name','projects'] : ['username','password']);
  text(input.username, 32); text(input.password, 200);
  if (isThrottled(ip, input.username)) throw Error('LOGIN_THROTTLED');
  if (native) {
    if (typeof input.installation !== 'string' || !/^[0-9a-f]{64}$/.test(input.installation)) throw Error('INVALID_INSTALLATION');
    text(input.name, 80);
    if (!Array.isArray(input.projects) || input.projects.length > contract.workspaceLimit) throw Error('INVALID_PROJECTS');
    for (const p of input.projects) validateWorkspace(p);
    if (new Set(input.projects.map(p => p.localId)).size !== input.projects.length) throw Error('INVALID_PROJECTS');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = checkCredentials(input.username, input.password);
    if (!user) { recordFailure(ip, input.username); throw Error('INVALID_CREDENTIALS'); }
    let deviceId = null;
    if (native) {
      const hash = digest(input.installation);
      const prior = db.prepare('SELECT id,disabled FROM mcp_devices WHERE user_id=? AND installation_hash=?').get(user.id,hash);
      if (prior?.disabled) throw Error('DEVICE_DISABLED');
      deviceId = prior?.id ?? randomUUID();
      db.prepare(`INSERT INTO mcp_devices(id,user_id,installation_hash,name) VALUES(?,?,?,?)
        ON CONFLICT(user_id,installation_hash) DO UPDATE SET name=excluded.name`).run(deviceId,user.id,hash,input.name);
      for (const p of input.projects) upsertWorkspace.get(randomUUID(),deviceId,p.localId,p.label);
      invalidateDevice(deviceId);
    }
    const token = createAuthSession(user.id);
    db.prepare('INSERT INTO mcp_logins VALUES(?,?)').run(digest(token),deviceId);
    db.exec('COMMIT');
    return {user, deviceId, token};
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function authenticate(token) {
  if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw Error('LOGIN_REQUIRED');
  const user = userFromToken(token);
  const row = db.prepare(`SELECT l.device_id AS deviceId,d.disabled,d.user_id AS owner
    FROM mcp_logins l LEFT JOIN mcp_devices d ON d.id=l.device_id WHERE l.token_hash=?`).get(digest(token));
  if (!row || !user || (row.deviceId && (row.disabled || row.owner !== user.id))) throw Error('LOGIN_REQUIRED');
  return { user, deviceId: row.deviceId };
}

export function logout(token) { destroyAuthSession(token); }

export function registerWorkspace(token, input) {
  validateWorkspace(input);
  db.exec('BEGIN IMMEDIATE');
  try {
    const {deviceId}=authenticate(token);
    if (!deviceId) throw Error('FORBIDDEN');
    const existing=db.prepare('SELECT id FROM mcp_workspaces WHERE device_id=? AND local_id=?').get(deviceId,input.localId);
    if (!existing && db.prepare('SELECT COUNT(*) AS total FROM mcp_workspaces WHERE device_id=?').get(deviceId).total>=contract.workspaceLimit) {
      throw Error('WORKSPACE_LIMIT');
    }
    const project=upsertWorkspace.get(randomUUID(),deviceId,input.localId,input.label);
    db.exec('COMMIT');
    return project;
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}

export function removeWorkspace(token, workspaceId) {
  uuid(workspaceId);
  db.exec('BEGIN IMMEDIATE');
  try {
    const { deviceId } = authenticate(token);
    if (!deviceId) throw Error('FORBIDDEN');
    const deleted = db.prepare('DELETE FROM mcp_workspaces WHERE id=? AND device_id=?').run(workspaceId, deviceId);
    if (!deleted.changes) throw Error('NOT_FOUND');
    db.exec('COMMIT');
    return { ok: true, id: workspaceId };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function changePassword(token, input) {
  fields(input, ['current','password']);
  text(input.current, 200);
  if (typeof input.password !== 'string' || !input.password.trim() || passwordProblem(input.password)) {
    throw Error('INVALID_NEW_PASSWORD');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const {user} = authenticate(token);
    const key = 'change-password:' + user.id;
    if (isThrottledKey(key)) throw Error('PASSWORD_THROTTLED');
    if (!checkPassword(user.id, input.current)) {
      recordFailureKey(key);
      throw Error('INCORRECT_CURRENT_PASSWORD');
    }
    if (input.password === input.current) throw Error('PASSWORD_UNCHANGED');
    setPassword(user.id, input.password, token);
    db.exec('COMMIT');
    return user.id;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function invalidateDevice(id) {
  db.prepare('DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM mcp_logins WHERE device_id=?)').run(id);
}

export function setDisabled(id, disabled) {
  uuid(id);
  if (typeof disabled !== 'boolean') throw Error('INVALID_FIELDS');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('UPDATE mcp_devices SET disabled=? WHERE id=?').run(Number(disabled),id).changes) throw Error('NOT_FOUND');
    if (disabled) invalidateDevice(id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function seen(id, at=Date.now()) { db.prepare('UPDATE mcp_devices SET last_seen=? WHERE id=?').run(at,id); }
export function devices(userId) {
  const sql = `SELECT d.id,d.name,d.last_seen AS lastSeen,d.disabled,u.username,u.id AS userId
    FROM mcp_devices d JOIN users u ON u.id=d.user_id`;
  return userId === undefined ? db.prepare(sql+' ORDER BY u.username,d.name,d.id').all()
    : db.prepare(sql+' WHERE u.id=? ORDER BY d.name,d.id').all(userId);
}
export function workspaces(userId) {
  return db.prepare(`SELECT w.id,w.device_id AS deviceId,w.local_id AS localId,w.label
    FROM mcp_workspaces w JOIN mcp_devices d ON d.id=w.device_id WHERE d.user_id=? ORDER BY w.label,w.id`).all(userId);
}
export function accountIds() { return db.prepare('SELECT DISTINCT user_id AS id FROM mcp_devices').all().map(r=>r.id); }
