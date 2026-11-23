import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function expandHome(p) {
  return p.startsWith('~') ? resolve(homedir(), p.slice(1).replace(/^\/+/, '')) : resolve(p);
}

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const dataDir = expandHome(process.env.DATA_DIR || '~/.anywhere-mesh');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(resolve(dataDir, 'data.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

for (const ddl of [
  'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN last_login_at INTEGER',
]) {
  try { db.exec(ddl); } catch {}
}
db.exec(
  'UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)',
);
