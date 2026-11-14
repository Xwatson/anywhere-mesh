import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessionHolder {
  pid: number;
  /** How that Claude Code process was started: cli, sdk-ts, … */
  entrypoint: string;
}

const REGISTRY = join(homedir(), '.claude', 'sessions');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Live Claude Code processes outside this service that have the session open, read
 * from Claude Code's own registry (~/.claude/sessions/<pid>.json). Processes started
 * through the SDK are excluded, since those are normally this service's own runners.
 */
export function claudeHoldersElsewhere(sessionId: string): SessionHolder[] {
  let files: string[];
  try {
    files = readdirSync(REGISTRY).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: SessionHolder[] = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(REGISTRY, f), 'utf8'));
      if (s.sessionId === sessionId && s.entrypoint !== 'sdk-ts' && alive(s.pid)) {
        out.push({ pid: s.pid, entrypoint: s.entrypoint ?? 'unknown' });
      }
    } catch {
      /* file removed or half-written */
    }
  }
  return out;
}
