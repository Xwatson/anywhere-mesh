import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSIONS = join(homedir(), '.codex', 'sessions');
const pathCache = new Map<string, string>();

/** Finds a thread's rollout file (~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl). */
async function rolloutPath(threadId: string): Promise<string | null> {
  const hit = pathCache.get(threadId);
  if (hit) return hit;
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    // Newest first: recent threads are found quickly.
    for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const p = join(dir, e.name);
      if (depth < 3 && e.isDirectory()) {
        const found = await walk(p, depth + 1);
        if (found) return found;
      } else if (depth === 3 && e.name.endsWith(`${threadId}.jsonl`)) {
        return p;
      }
    }
    return null;
  };
  const found = await walk(SESSIONS, 0);
  if (found) pathCache.set(threadId, found);
  return found;
}

/**
 * Current context size of a Codex thread, from the last token_count record Codex
 * itself wrote to the rollout file. Local read only; no requests are made.
 */
export async function codexContext(threadId: string): Promise<{ used: number; window?: number } | null> {
  const path = await rolloutPath(threadId);
  if (!path) return null;
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      try {
        const info = JSON.parse(lines[i]).payload?.info;
        if (info?.last_token_usage) {
          return { used: info.last_token_usage.total_tokens, window: info.model_context_window ?? undefined };
        }
      } catch {
        /* partial first line */
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}
