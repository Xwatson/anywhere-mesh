import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    agent TEXT NOT NULL,
    cwd TEXT NOT NULL,
    agent_session_id TEXT,
    options TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
`);

// Added after the first release; ignore the error when the column already exists.
try {
  db.exec('ALTER TABLE chat_sessions ADD COLUMN external_mark INTEGER');
} catch {
  /* column exists */
}
// Sessions created from the web without a title start out named after their folder;
// title_auto marks those so the title can follow the conversation until the user renames it.
try {
  db.exec('ALTER TABLE chat_sessions ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0');
  const rows = db.prepare('SELECT id, title, cwd FROM chat_sessions').all() as { id: string; title: string; cwd: string }[];
  const mark = db.prepare('UPDATE chat_sessions SET title_auto = 1 WHERE id = ?');
  for (const r of rows) if (r.title === basename(r.cwd)) mark.run(r.id);
} catch {
  /* column exists */
}
// Sessions that work in their own git worktree (JSON: repo, path, branch, base).
try {
  db.exec('ALTER TABLE chat_sessions ADD COLUMN worktree TEXT');
} catch {
  /* column exists */
}
// Sessions with a role other than coding: 'advisor' = the project's steward (管家).
try {
  db.exec('ALTER TABLE chat_sessions ADD COLUMN role TEXT');
} catch {
  /* column exists */
}
// steward <-> coding-session loop state (JSON): pendingRelay on the advisor; reportedHead, rounds on the coding session.
try {
  db.exec('ALTER TABLE chat_sessions ADD COLUMN loop TEXT');
} catch {
  /* column exists */
}
// Where a session came from: JSON { file, advisorId } for coding sessions started from a brief.
try {
  db.exec('ALTER TABLE chat_sessions ADD COLUMN source TEXT');
} catch {
  /* column exists */
}

// A member's session works in a folder on the member's own computer (its project): that folder's path there.
try {
  db.exec('ALTER TABLE chat_sessions ADD COLUMN remote_cwd TEXT');
} catch {
  /* column exists */
}

// ---- accounts: admins add the other accounts from the web (there is no sign-up) ----
try {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
} catch {
  /* column exists */
}
try {
  db.exec('ALTER TABLE users ADD COLUMN last_login_at INTEGER');
} catch {
  /* column exists */
}
// A member's own computer (SSH destination: user@host or a ~/.ssh/config alias, optional port):
// its agents work there and nowhere else.
try {
  db.exec('ALTER TABLE users ADD COLUMN remote_host TEXT');
  db.exec('ALTER TABLE users ADD COLUMN remote_port INTEGER');
} catch {
  /* columns exist */
}
// There is always an admin: the oldest account (the only one before accounts existed) becomes it.
db.exec(
  `UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)`,
);
// Every session belongs to one account; sessions from before accounts belong to the first admin.
try {
  db.exec('ALTER TABLE chat_sessions ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
} catch {
  /* column exists */
}
db.exec(`UPDATE chat_sessions SET user_id = (SELECT MIN(id) FROM users WHERE is_admin = 1) WHERE user_id IS NULL`);
db.exec('CREATE INDEX IF NOT EXISTS chat_sessions_user ON chat_sessions (user_id, updated_at)');

/** The first admin: owner of data from before accounts existed. */
export function firstAdminId(): number | null {
  return (db.prepare('SELECT MIN(id) AS id FROM users WHERE is_admin = 1').get() as { id: number | null }).id;
}

// ---- share links: anyone with the link (and its password, when set) may read the session until it expires ----
// upto_seq: the link shows the conversation as it was when shared (null: also what comes after).
db.exec(`
  CREATE TABLE IF NOT EXISTS session_shares (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    password_hash TEXT,
    upto_seq INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_shares_session ON session_shares (session_id);
`);
