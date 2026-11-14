import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import type { AgentModels, EffortLevel, ModelOption } from '../shared/protocol.js';
import { codexAppServer } from './codexAppServer.js';

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; value: Promise<AgentModels> } | null = null;

export function getModels(): Promise<AgentModels> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = load();
  cache = { at: Date.now(), value };
  value.catch(() => (cache = null));
  return value;
}

/** Used when Claude Code cannot be asked (e.g. not logged in). */
const CLAUDE_FALLBACK: ModelOption[] = ['opus', 'sonnet', 'haiku'].map((id) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
}));

/**
 * Claude Code's own model list. Starting the CLI without sending a prompt makes no
 * model call; it only answers the SDK's control request.
 */
async function claudeModels(): Promise<ModelOption[]> {
  const idle = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
  const cwd = join(config.dataDir, 'tmp');
  mkdirSync(cwd, { recursive: true });
  const q = query({
    prompt: idle as never,
    options: { cwd, persistSession: false, pathToClaudeCodeExecutable: config.claudePath } as never,
  });
  try {
    const list = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
    ]);
    return list.map((m) => ({
      id: m.value,
      name: m.displayName,
      description: m.description,
      efforts: (m.supportedEffortLevels ?? []) as EffortLevel[],
    }));
  } finally {
    q.close();
  }
}

interface CodexModel {
  id: string;
  displayName?: string;
  description?: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: EffortLevel }[];
  defaultReasoningEffort?: EffortLevel;
}

/** Top-level `key = "value"` from ~/.codex/config.toml, enough to show the user's defaults. */
async function codexConfig(key: string): Promise<string | undefined> {
  const text = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8').catch(() => '');
  const top = text.split(/^\[/m)[0];
  return top.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
}

async function load(): Promise<AgentModels> {
  const [claude, codexList, configuredEffort, configuredModel] = await Promise.all([
    claudeModels().catch(() => CLAUDE_FALLBACK),
    codexAppServer.call<{ data: CodexModel[] }>('model/list', {}).catch(() => ({ data: [] as CodexModel[] })),
    codexConfig('model_reasoning_effort'),
    codexConfig('model'),
  ]);
  return {
    claude: { models: claude },
    codex: {
      models: codexList.data.map((m) => ({
        id: m.id,
        name: m.displayName || m.id,
        description: m.description,
        isDefault: m.isDefault,
        efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
        defaultEffort: m.defaultReasoningEffort,
      })),
      configuredEffort,
      configuredModel,
    },
  };
}
