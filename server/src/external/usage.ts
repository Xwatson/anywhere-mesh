import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import type { AgentUsage, UsageInfo, UsageWindow } from '../shared/protocol.js';
import { codexAppServer } from './codexAppServer.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const CACHE_MS = 60_000;

let cache: { at: number; value: Promise<UsageInfo> } | null = null;

export function getUsage(refresh = false): Promise<UsageInfo> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = Promise.all([claudeUsage(), codexUsage()]).then(([claude, codex]) => ({ claude, codex }));
  cache = { at: Date.now(), value };
  return value;
}

function claudeBinary(): string {
  if (config.claudePath) return config.claudePath;
  return 'claude';
}

function bundledClaude(): string | null {
  try {
    return join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/package.json')), 'claude');
  } catch {
    return null;
  }
}

/**
 * Runs Claude Code's own `/usage` command non-interactively. It is answered
 * locally (no model call, no cost) and nothing is written to session history.
 */
async function claudeUsage(): Promise<AgentUsage> {
  const args = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'];
  const opts = { cwd: config.dataDir, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 };
  try {
    let stdout: string;
    try {
      ({ stdout } = await run(claudeBinary(), args, opts));
    } catch (e) {
      const fallback = bundledClaude();
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !fallback) throw e;
      ({ stdout } = await run(fallback, args, opts));
    }
    const text = String(JSON.parse(stdout).result ?? '');
    return parseClaudeUsage(text);
  } catch (e) {
    return { ok: false, error: `读取 Claude 额度失败: ${(e as Error).message.slice(0, 200)}`, windows: [], fetchedAt: Date.now() };
  }
}

const CLAUDE_LABELS: Record<string, string> = {
  'Current session': '5 小时',
  'Current week (all models)': '本周 · 全部模型',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parses the CLI's reset text, e.g. "Oct 17, 5:59am (Asia/Shanghai)". The CLI prints
 * this machine's local time zone, which is also ours, so a local Date is correct.
 */
function parseResetTime(text: string | undefined): number | undefined {
  const m = text?.match(/^([A-Za-z]{3})\w*\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const now = new Date();
  const d = new Date(now.getFullYear(), month, Number(m[2]), hour, Number(m[4] ?? 0));
  // Resets are always in the future; a date far in the past means it wraps into next year.
  if (d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

export function parseClaudeUsage(text: string): AgentUsage {
  const windows: UsageWindow[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(Current [^:]+):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+))?\s*$/i);
    if (!m) continue;
    const name = m[1].trim();
    const week = name.match(/^Current week \((.+)\)$/);
    windows.push({
      label: CLAUDE_LABELS[name] ?? (week ? `本周 · ${week[1]}` : name),
      usedPercent: Number(m[2]),
      resetsAt: parseResetTime(m[3]?.trim()),
      resetsText: m[3]?.trim(),
    });
  }
  const plan = text.match(/using your (\w+) to power/i)?.[1];
  if (!windows.length) {
    // API-key users have no plan windows; show what the CLI said.
    return { ok: true, windows, notes: text.split('\n').filter(Boolean).slice(0, 3), fetchedAt: Date.now() };
  }
  return { ok: true, plan: plan === 'subscription' ? '订阅' : plan, windows, fetchedAt: Date.now() };
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  planType: string | null;
}

function windowLabel(mins: number | null): string {
  if (!mins) return '额度';
  if (mins === 300) return '5 小时';
  if (mins === 10080) return '每周';
  if (mins % 1440 === 0) return `${mins / 1440} 天`;
  if (mins % 60 === 0) return `${mins / 60} 小时`;
  return `${mins} 分钟`;
}

async function codexUsage(): Promise<AgentUsage> {
  try {
    const r: { rateLimits: RateLimitSnapshot; rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null } =
      await codexAppServer.call('account/rateLimits/read', {});
    const snapshots = Object.values(r.rateLimitsByLimitId ?? {}).length
      ? Object.values(r.rateLimitsByLimitId!)
      : [r.rateLimits];
    const windows: UsageWindow[] = [];
    for (const s of snapshots) {
      const prefix = s.limitName && snapshots.length > 1 ? `${s.limitName} · ` : '';
      for (const w of [s.primary, s.secondary]) {
        if (!w) continue;
        windows.push({
          label: prefix + windowLabel(w.windowDurationMins),
          usedPercent: w.usedPercent,
          resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined,
        });
      }
    }
    const credits = r.rateLimits.credits;
    const notes: string[] = [];
    if (credits?.unlimited) notes.push('credits：无限');
    else if (credits?.hasCredits && credits.balance) notes.push(`credits 余额：${Number(credits.balance).toLocaleString()}`);
    return { ok: true, plan: r.rateLimits.planType ?? undefined, windows, notes, fetchedAt: Date.now() };
  } catch (e) {
    return { ok: false, error: `读取 Codex 额度失败: ${(e as Error).message.slice(0, 200)}`, windows: [], fetchedAt: Date.now() };
  }
}
