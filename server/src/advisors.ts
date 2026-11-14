import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from './config.js';
import { firstAdminId } from './db.js';
import type { AdvisorMemory, AdvisorSettings, BriefInfo } from './shared/protocol.js';

/**
 * The product advisor's memory: a few markdown files it maintains itself, in the order
 * the UI shows them. Templates explain what belongs where; the advisor fills them in.
 */
export const MEMORY_FILES: { name: string; label: string; template: string }[] = [
  {
    name: 'PRODUCT.md',
    label: '项目画像',
    template: `# 项目画像

> 管家对这个产品的理解。每次了解到新东西就更新；拿不准的标「待确认」。

## 定位
（这是什么产品、给谁用、解决什么问题——一两句话）

## 用户与角色
（谁在用、各自关心什么）

## 核心流程
（用户从头到尾怎么用，关键步骤）

## 术语
（行业与项目里的专有名词及含义）

## 现状评价
（功能完成度、界面与交互的水平、明显的短板）

## 已知痛点
（用户提过的、甲方反馈过的、你观察到的）
`,
  },
  {
    name: 'CLIENT.md',
    label: '甲方',
    template: `# 甲方

> 甲方是谁、他们怎么想、说过什么。原话照录，解读另写，别混在一起。

## 档案
（公司 / 部门、对接人、他们的业务、他们评价产品时看什么）

## 已确认事项
（甲方明确拍过板的，带日期）

## 待确认问题
（要问甲方的。每条写成甲方能直接回答的形式：描述效果 + A 还是 B）

## 沟通记录
（倒序。日期 · 甲方原话 → 管家的解读 → 由此做的决定）
`,
  },
  {
    name: 'MARKET.md',
    label: '竞品与开源',
    template: `# 竞品与开源项目

> 看过什么、学到什么。每条带来源链接和日期，没有来源的不要写。

## 竞品
（名称 · 链接 · 日期 · 看到了什么（功能 / 界面 / 交互）· 对我们的启示）

## 开源项目
（同上）

## 行业惯例
（这个行业默认怎么做，来源）
`,
  },
  {
    name: 'DECISIONS.md',
    label: '决策日志',
    template: `# 决策日志

> 只追加，不改写历史；改主意就新记一条并引用旧的。
> 状态：建议中 / 待甲方确认 / 已采纳 / 已否决

<!-- 每条的格式：
## YYYY-MM-DD · 一句话标题
- 问题：
- 决定：
- 理由：
- 状态：
-->
`,
  },
  {
    name: 'BACKLOG.md',
    label: '提案与待办',
    template: `# 提案与待办

> 还没做的事，按优先级排。每条带证据（来自哪条甲方反馈 / 哪个竞品 / 哪条观察）。
> 状态：待议 / 待甲方确认 / 可开工 / 已交接 / 已否决

## P0

## P1

## P2
`,
  },
];

const ADVISORS_ROOT = join(config.dataDir, 'advisors');

/** Every advisor memory of one account. */
export const accountAdvisorsDir = (userId: number) => join(ADVISORS_ROOT, `u${userId}`);

/**
 * Where an account's advisor of a project keeps its memory: under DATA_DIR, never inside the
 * project. Each account has its own, as each has its own sessions (stewards are for admins:
 * they need the project on this machine).
 */
export function advisorDir(project: string, userId: number): string {
  const hash = createHash('sha1').update(project).digest('hex').slice(0, 8);
  const name = (basename(project) || 'root').replace(/[^\w.-]+/g, '_').slice(0, 60);
  return join(accountAdvisorsDir(userId), `${name}-${hash}`);
}

/** Removes an account's advisor memories (the account is being deleted). */
export function deleteAccountAdvisors(userId: number) {
  rmSync(accountAdvisorsDir(userId), { recursive: true, force: true });
}

/**
 * Memories from before accounts existed sit directly in advisors/; they belong to the first
 * admin, who owned every session then. Moved once, at startup, before any advisor runs.
 */
function adoptLegacyMemories() {
  if (!existsSync(ADVISORS_ROOT)) return;
  const legacy = readdirSync(ADVISORS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^u\d+$/.test(e.name));
  const owner = firstAdminId();
  if (!legacy.length || owner === null) return;
  const dest = accountAdvisorsDir(owner);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const e of legacy) {
    const to = join(dest, e.name);
    if (existsSync(to)) console.warn(`[advisors] ${e.name} 已经在 ${dest} 里，旧目录保留未动`);
    else renameSync(join(ADVISORS_ROOT, e.name), to);
  }
}

adoptLegacyMemories();

/** Creates the memory folder with the templates; files that already exist are left alone. */
export function ensureAdvisorMemory(dir: string) {
  mkdirSync(join(dir, BRIEFS_DIR), { recursive: true, mode: 0o700 });
  for (const f of MEMORY_FILES) {
    const path = join(dir, f.name);
    if (!existsSync(path)) writeFileSync(path, f.template, { mode: 0o600 });
  }
}

// ---- briefs (需求书): one markdown file each, written by the advisor, handed to coding sessions ----

/** Subfolder of the memory dir where the advisor puts briefs. */
export const BRIEFS_DIR = 'briefs';

export const briefsDir = (memoryDir: string) => join(memoryDir, BRIEFS_DIR);

/** The hand-off record appended to a brief (see markHandedOff). */
const HANDOFF = /^交接：(.+?) → 会话 ([\w-]+)(?:，分支 `([^`\n]+)`)?/gm;

function parseBrief(path: string, file: string): BriefInfo {
  const content = readFileSync(path, 'utf8');
  const heading = content.match(/^#\s+(.+?)\s*$/m)?.[1] ?? '';
  const title = heading.replace(/^需求书[:：]\s*/, '') || file.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const h = [...content.matchAll(HANDOFF)].at(-1);
  const ready = /^(?:[-*]\s*)?状态[:：]\s*可开工/m.test(content);
  return { file, title, status: h ? 'handed_off' : 'new', ready, sessionId: h?.[2], branch: h?.[3], updatedAt: statSync(path).mtimeMs, content };
}

/** All briefs, newest first. */
export function listBriefs(memoryDir: string): BriefInfo[] {
  const dir = briefsDir(memoryDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => parseBrief(join(dir, f), f))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readBrief(memoryDir: string, file: string): BriefInfo | null {
  if (!file || file !== basename(file) || file.startsWith('.') || !file.endsWith('.md')) return null;
  const path = join(briefsDir(memoryDir), file);
  return existsSync(path) ? parseBrief(path, file) : null;
}

const localStamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Records the hand-off at the end of the brief, where the advisor sees it the next time it reads the file. */
export function markHandedOff(memoryDir: string, file: string, to: { sessionId: string; branch?: string; title: string }) {
  const line = `交接：${localStamp()} → 会话 ${to.sessionId}${to.branch ? `，分支 \`${to.branch}\`` : ''}（${to.title}）`;
  appendFileSync(join(briefsDir(memoryDir), file), `\n\n---\n${line}\n`);
}

/** The steward runs the project by itself: everything on unless the project says otherwise. */
export const DEFAULT_SETTINGS: AdvisorSettings = { autoHandoff: true, maxConcurrent: 1, dailyLimit: 5, quotaStopPercent: 80, patrol: true, patrolHours: 24, autoMerge: true, cleanupAfterMerge: true };

export function readAdvisorSettings(memoryDir: string): AdvisorSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(join(memoryDir, 'settings.json'), 'utf8')) as Partial<AdvisorSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeAdvisorSettings(memoryDir: string, patch: Partial<AdvisorSettings>): AdvisorSettings {
  const next = { ...readAdvisorSettings(memoryDir), ...patch };
  mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(memoryDir, 'settings.json'), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

export function readAdvisorMemory(dir: string): AdvisorMemory {
  return {
    dir,
    files: MEMORY_FILES.flatMap((f) => {
      const path = join(dir, f.name);
      if (!existsSync(path)) return [];
      return [{ name: f.name, label: f.label, content: readFileSync(path, 'utf8'), updatedAt: statSync(path).mtimeMs }];
    }),
  };
}
