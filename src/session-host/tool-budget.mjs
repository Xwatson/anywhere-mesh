import { CATALOG } from '../workspace/catalog.mjs';
import { MEMORY_TOOL_NAMES } from './memory.mjs';

const TOOL_BY_NAME = new Map(CATALOG.map(tool => [tool.name, tool]));

export const LOCAL_TOOL_NAMES = new Set(['session_read_attachment', ...MEMORY_TOOL_NAMES]);

export const DEFAULT_TOOL_BUDGET = Object.freeze({
  maxTotalCalls: 240,
  maxMutationCalls: 120,
  maxLocalCalls: 60,
  warnRemainingTotal: 20,
  warnRemainingMutations: 15,
  maxConsecutiveFailures: 10,
  maxConsecutiveIdentical: 5,
  maxConsecutiveIdenticalFailures: 3,
});

function parseIntInRange(value, min, max) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

export function resolveToolBudget(overrides = {}, env = process.env) {
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  const maxTotalCalls =
    parseIntInRange(src.maxTotalCalls, 1, 2000) ??
    parseIntInRange(env?.ANYWHERE_MAX_TOOL_CALLS, 1, 2000) ??
    DEFAULT_TOOL_BUDGET.maxTotalCalls;

  const rawMutationCalls =
    parseIntInRange(src.maxMutationCalls, 1, 2000) ??
    parseIntInRange(env?.ANYWHERE_MAX_MUTATION_CALLS, 1, 2000) ??
    DEFAULT_TOOL_BUDGET.maxMutationCalls;
  const maxMutationCalls = Math.min(rawMutationCalls, maxTotalCalls);

  const maxLocalCalls =
    parseIntInRange(src.maxLocalCalls, 1, 500) ??
    parseIntInRange(env?.ANYWHERE_MAX_LOCAL_TOOL_CALLS, 1, 500) ??
    DEFAULT_TOOL_BUDGET.maxLocalCalls;

  const explicitWarnTotal = parseIntInRange(src.warnRemainingTotal, 0, 2000);
  const warnRemainingTotal = explicitWarnTotal !== undefined
    ? Math.min(explicitWarnTotal, Math.max(0, maxTotalCalls - 1))
    : Math.min(DEFAULT_TOOL_BUDGET.warnRemainingTotal, Math.max(0, Math.floor(maxTotalCalls / 3)));

  const explicitWarnMutations = parseIntInRange(src.warnRemainingMutations, 0, 2000);
  const warnRemainingMutations = explicitWarnMutations !== undefined
    ? Math.min(explicitWarnMutations, Math.max(0, maxMutationCalls - 1))
    : Math.min(DEFAULT_TOOL_BUDGET.warnRemainingMutations, Math.max(0, Math.floor(maxMutationCalls / 3)));

  const maxConsecutiveFailures =
    parseIntInRange(src.maxConsecutiveFailures, 2, 100) ??
    parseIntInRange(env?.ANYWHERE_MAX_CONSECUTIVE_FAILURES, 2, 100) ??
    DEFAULT_TOOL_BUDGET.maxConsecutiveFailures;

  const maxConsecutiveIdentical =
    parseIntInRange(src.maxConsecutiveIdentical, 2, 50) ??
    parseIntInRange(env?.ANYWHERE_MAX_IDENTICAL_CALLS, 2, 50) ??
    DEFAULT_TOOL_BUDGET.maxConsecutiveIdentical;

  const rawIdenticalFailures =
    parseIntInRange(src.maxConsecutiveIdenticalFailures, 2, 50) ??
    parseIntInRange(env?.ANYWHERE_MAX_IDENTICAL_FAILURES, 2, 50) ??
    DEFAULT_TOOL_BUDGET.maxConsecutiveIdenticalFailures;
  const maxConsecutiveIdenticalFailures = Math.min(rawIdenticalFailures, maxConsecutiveIdentical);

  return Object.freeze({
    maxTotalCalls,
    maxMutationCalls,
    maxLocalCalls,
    warnRemainingTotal,
    warnRemainingMutations,
    maxConsecutiveFailures,
    maxConsecutiveIdentical,
    maxConsecutiveIdenticalFailures,
  });
}

export function classifyTool(toolName) {
  if (LOCAL_TOOL_NAMES.has(toolName)) return 'local';
  if (toolName === 'session_send_attachment') return 'mutation';
  const tool = TOOL_BY_NAME.get(toolName);
  if (tool) return tool.mutates ? 'mutation' : 'read';
  return 'mutation';
}

export function isMutationTool(toolName) {
  return classifyTool(toolName) === 'mutation';
}

const LARGE_TEXT_KEYS = new Set(['content', 'patch', 'oldText', 'newText', 'input', 'expression', 'text']);
const IDENTITY_KEYS = [
  'path', 'fromPath', 'toPath', 'mode', 'attachment', 'key', 'scope',
  'pattern', 'searchType', 'cwd', 'offset', 'length', 'depth', 'maxResults',
  'expectedRevision', 'expectedFromRevision', 'expectedToRevision', 'expectedMatches',
  'processId', 'afterSeq', 'target', 'tabId', 'url', 'action', 'ref', 'selector', 'kind',
];

function truncateString(str, maxChars) {
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars)}… [truncated, ${str.length} chars]`;
}

export function summarizeCallArgs(args, maxBytes = 4096) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  try {
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') <= maxBytes) return args;
  } catch {
    return {};
  }
  const perFieldChars = Math.max(120, Math.floor(maxBytes / 8));
  const compact = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const cap = LARGE_TEXT_KEYS.has(k) ? Math.min(perFieldChars, 240) : Math.min(perFieldChars, 512);
      compact[k] = truncateString(v, cap);
    } else if (Array.isArray(v)) {
      const sliced = v.slice(0, 10).map(item => (typeof item === 'string' ? truncateString(item, 200) : item));
      if (v.length > 10) sliced.push(`… (+${v.length - 10} more)`);
      compact[k] = sliced;
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      compact[k] = keys.length <= 8
        ? Object.fromEntries(keys.map(sub => [sub, typeof v[sub] === 'string' ? truncateString(v[sub], 120) : v[sub]]))
        : { _keys: keys.slice(0, 8), _count: keys.length };
    } else {
      compact[k] = v;
    }
  }
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') <= maxBytes) return compact;

  const minimal = {};
  for (const k of IDENTITY_KEYS) {
    if (Object.hasOwn(args, k)) {
      const v = args[k];
      minimal[k] = typeof v === 'string' ? truncateString(v, 240) : v;
    }
  }
  if (typeof args.command === 'string') minimal.command = truncateString(args.command, 240);
  if (Array.isArray(args.paths)) minimal.paths = args.paths.slice(0, 5).map(p => truncateString(String(p), 160));
  minimal._truncated = true;
  return minimal;
}

export function boundEventInput(args, maxBytes = 16384) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  try {
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') <= maxBytes) return args;
  } catch {
    return {};
  }
  return summarizeCallArgs(args, maxBytes);
}

export class TurnToolGuard {
  constructor(policyOrOverrides = {}, initialCalls = []) {
    this.policy = resolveToolBudget(policyOrOverrides);
    this.workspaceTotal = 0;
    this.workspaceMutations = 0;
    this.localTotal = 0;
    this.consecutiveFailures = 0;
    this.recentKey = null;
    this.consecutiveIdentical = 0;
    this.consecutiveIdenticalFailures = 0;
    this.circuitBroken = false;
    this.emittedNotices = new Set();

    for (const call of initialCalls ?? []) {
      if (!call?.counted) continue;
      const eff = call.effectiveTool ?? call.tool;
      this.recordWorkspaceDispatched(eff);
      if (call.ok === true || call.ok === false || call.ok === 1 || call.ok === 0) {
        this.recordWorkspaceOutcome(eff, call.inputHash ?? '', Boolean(call.ok));
      }
    }
  }

  markNoticeEmitted(code) {
    if (this.emittedNotices.has(code)) return false;
    this.emittedNotices.add(code);
    return true;
  }

  checkLocal() {
    if (this.localTotal >= this.policy.maxLocalCalls) {
      return {
        allowed: false,
        code: 'local_tool_limit',
        terminal: false,
        modelMessage: `Local tool call limit reached for this turn (${this.localTotal}/${this.policy.maxLocalCalls}). Summarize your findings and let the user continue in the next turn if more attachment or memory lookups are needed.`,
        notice: {
          code: 'local_tool_limit',
          level: 'warn',
          title: '本回合本地工具调用已达上限',
          detail: `已执行 ${this.localTotal}/${this.policy.maxLocalCalls} 次附件/记忆调用，后续本地调用已暂停。`,
          canContinue: true,
        },
      };
    }
    return { allowed: true };
  }

  recordLocal() {
    this.localTotal += 1;
  }

  checkWorkspace(effectiveTool, inputHash) {
    if (this.circuitBroken) {
      return {
        allowed: false,
        code: 'consecutive_failures',
        terminal: true,
        modelMessage: `Circuit breaker tripped: ${this.consecutiveFailures} consecutive workspace tool calls failed (limit ${this.policy.maxConsecutiveFailures}). Stop retrying, explain the blocker clearly to the user, and wait for further instructions.`,
        notice: this.circuitNotice(),
      };
    }
    if (this.workspaceTotal >= this.policy.maxTotalCalls) {
      return {
        allowed: false,
        code: 'tool_limit',
        terminal: true,
        modelMessage: `Workspace tool budget reached for this turn (${this.workspaceTotal}/${this.policy.maxTotalCalls}). Do not call more workspace tools; summarize what is completed, what remains, and invite the user to continue.`,
        notice: {
          code: 'tool_limit',
          level: 'warn',
          title: '本回合工具调用已达上限',
          detail: `已执行 ${this.workspaceTotal}/${this.policy.maxTotalCalls} 次工作区调用（写/执行 ${this.workspaceMutations}/${this.policy.maxMutationCalls}），后续调用已暂停。`,
          canContinue: true,
        },
      };
    }
    if (isMutationTool(effectiveTool) && this.workspaceMutations >= this.policy.maxMutationCalls) {
      const remainingReads = Math.max(0, this.policy.maxTotalCalls - this.workspaceTotal);
      return {
        allowed: false,
        code: 'mutation_limit',
        terminal: false,
        modelMessage: `Write/execute tool budget reached for this turn (${this.workspaceMutations}/${this.policy.maxMutationCalls}).${remainingReads > 0 ? ` Read-only inspection tools remain available (${remainingReads} total calls left) so you can verify status before wrapping up.` : ''} Summarize completed edits and remaining work so the user can continue.`,
        notice: {
          code: 'mutation_limit',
          level: 'warn',
          title: '写/执行调用已达本回合上限',
          detail: `已执行 ${this.workspaceMutations}/${this.policy.maxMutationCalls} 次写/执行调用，后续修改已暂停${remainingReads > 0 ? '（只读检查仍可用）' : ''}。`,
          canContinue: true,
        },
      };
    }
    const key = `${effectiveTool}:${inputHash}`;
    if (key === this.recentKey && this.consecutiveIdenticalFailures >= this.policy.maxConsecutiveIdenticalFailures) {
      return {
        allowed: false,
        code: 'identical_failure_loop',
        terminal: false,
        modelMessage: `Repeated identical failing call blocked: ${effectiveTool} failed ${this.consecutiveIdenticalFailures} times consecutively with the exact same arguments. Inspect the error output and change your arguments or approach instead of retrying identically.`,
      };
    }
    if (key === this.recentKey && this.consecutiveIdentical >= this.policy.maxConsecutiveIdentical) {
      return {
        allowed: false,
        code: 'identical_call_loop',
        terminal: false,
        modelMessage: `Repeated identical call blocked: ${effectiveTool} was called ${this.consecutiveIdentical} times consecutively with the exact same arguments. Use the previous output or try a different call.`,
      };
    }
    return { allowed: true };
  }

  recordWorkspaceDispatched(effectiveTool) {
    this.workspaceTotal += 1;
    if (isMutationTool(effectiveTool)) this.workspaceMutations += 1;
  }

  recordWorkspaceOutcome(effectiveTool, inputHash, ok) {
    const wasBroken = this.circuitBroken;
    const key = `${effectiveTool}:${inputHash}`;
    if (ok) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.policy.maxConsecutiveFailures) {
        this.circuitBroken = true;
      }
    }
    if (key === this.recentKey) {
      this.consecutiveIdentical += 1;
      this.consecutiveIdenticalFailures = ok ? 0 : this.consecutiveIdenticalFailures + 1;
    } else {
      this.recentKey = key;
      this.consecutiveIdentical = 1;
      this.consecutiveIdenticalFailures = ok ? 0 : 1;
    }
    return {
      circuitTrippedNow: !wasBroken && this.circuitBroken,
      notice: !wasBroken && this.circuitBroken ? this.circuitNotice() : null,
    };
  }

  circuitNotice() {
    return {
      code: 'consecutive_failures',
      level: 'warn',
      title: '连续工具失败，已触发保护暂停',
      detail: `工作区工具连续失败 ${this.consecutiveFailures} 次，已暂停本回合后续调用以防死循环。`,
      canContinue: true,
      continuePrompt: '请结合刚才的报错分析原因，换一种方案继续完成任务。',
    };
  }

  softWarning(effectiveTool) {
    const remTotal = Math.max(0, this.policy.maxTotalCalls - this.workspaceTotal);
    const remMut = Math.max(0, this.policy.maxMutationCalls - this.workspaceMutations);
    if (this.circuitBroken) {
      return `[AnywhereMesh Notice] Consecutive tool failure limit reached (${this.consecutiveFailures}/${this.policy.maxConsecutiveFailures}). Further workspace calls will be blocked in this turn; summarize the blocker and next steps for the user.`;
    }
    if (remTotal === 0) {
      return `[AnywhereMesh Notice] Workspace tool budget exhausted for this turn (${this.workspaceTotal}/${this.policy.maxTotalCalls}). Do not call more workspace tools; summarize your progress and remaining work so the user can continue.`;
    }
    if (this.policy.warnRemainingTotal > 0 && remTotal <= this.policy.warnRemainingTotal) {
      return `[AnywhereMesh Budget] ${remTotal} workspace tool call${remTotal === 1 ? '' : 's'} remaining in this turn (${this.workspaceTotal}/${this.policy.maxTotalCalls}; write/run left: ${remMut}). Prioritize verification and wrap up cleanly.`;
    }
    if (isMutationTool(effectiveTool) && remMut === 0) {
      return `[AnywhereMesh Notice] Write/execute tool budget exhausted for this turn (${this.workspaceMutations}/${this.policy.maxMutationCalls}). Read-only tools remain available (${remTotal} total left) for verification; summarize your changes so the user can continue.`;
    }
    if (isMutationTool(effectiveTool) && this.policy.warnRemainingMutations > 0 && remMut <= this.policy.warnRemainingMutations) {
      return `[AnywhereMesh Budget] ${remMut} write/execute call${remMut === 1 ? '' : 's'} remaining in this turn (${this.workspaceMutations}/${this.policy.maxMutationCalls}; total left: ${remTotal}). Finish current edits and verify cleanly.`;
    }
    const failWarnAt = Math.max(3, this.policy.maxConsecutiveFailures - 2);
    if (this.policy.maxConsecutiveFailures >= 4 && this.consecutiveFailures >= failWarnAt) {
      const remFail = this.policy.maxConsecutiveFailures - this.consecutiveFailures;
      return `[AnywhereMesh Notice] ${this.consecutiveFailures} consecutive workspace tool failures (${remFail} more before circuit breaker pauses this turn). Diagnose the underlying error before retrying.`;
    }
    return null;
  }

  snapshot() {
    return {
      total: this.workspaceTotal,
      mutations: this.workspaceMutations,
      local: this.localTotal,
      consecutiveFailures: this.consecutiveFailures,
      circuitBroken: this.circuitBroken,
    };
  }
}

export function appendCodexWarning(reply, warning) {
  if (!warning || !reply || !Array.isArray(reply.contentItems)) return reply;
  const items = reply.contentItems.map(item => ({ ...item }));
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'inputText' && typeof items[i].text === 'string') {
      items[i].text = `${items[i].text}\n\n${warning}`;
      return { ...reply, contentItems: items };
    }
  }
  items.push({ type: 'inputText', text: warning });
  return { ...reply, contentItems: items };
}

export function appendAgyWarning(reply, warning) {
  if (!warning || !reply || !Array.isArray(reply.content)) return reply;
  const items = reply.content.map(item => ({ ...item }));
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'text' && typeof items[i].text === 'string') {
      items[i].text = `${items[i].text}\n\n${warning}`;
      return { ...reply, content: items };
    }
  }
  items.push({ type: 'text', text: warning });
  return { ...reply, content: items };
}
