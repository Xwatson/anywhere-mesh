import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '../..');

const envFile = resolve(projectRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function expandHome(p: string): string {
  return p.startsWith('~') ? resolve(homedir(), p.slice(1).replace(/^\/+/, '')) : resolve(p);
}

const dataDir = expandHome(process.env.DATA_DIR || '~/.anywhere-coding');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3210),
  dataDir,
  dbPath: resolve(dataDir, 'data.db'),
  workspaceRoots: (process.env.WORKSPACE_ROOTS || '~/workspace')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(expandHome),
  claudePath: process.env.CLAUDE_PATH || undefined,
  codexPath: process.env.CODEX_PATH || undefined,
  webDist: resolve(projectRoot, 'web/dist'),
  sessionTtlMs: 30 * 24 * 3600 * 1000,
  // Agent processes idle longer than this are closed; the next message resumes them.
  agentIdleMs: 30 * 60 * 1000,
};
