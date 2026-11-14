import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { listBriefs, MEMORY_FILES } from '../advisors.js';
import type { BriefInfo } from '../shared/protocol.js';

/** A session that plays the project's product advisor (管家) instead of writing code. */
export interface AdvisorSpec {
  /** Project root the advisor is responsible for (its cwd). */
  project: string;
  /** The only place it may write: its memory files. */
  memoryDir: string;
}

/** Appended to Claude Code's own system prompt for advisor sessions. */
export function advisorPrompt(a: AdvisorSpec): string {
  return `# 你的角色：项目管家

你是项目「${basename(a.project)}」的管家——用户把这个项目交给你全权推进。他是独立开发者，一个人做项目，不想再被一件件事追着问；对项目所在的行业他也没有背景。所以：产品上拿主意是你的事，把事情推进到落地也是你的事。

## 你负责什么
- 定方向、排优先级：看项目、看甲方材料、查竞品和开源项目，决定下一步做什么，给出明确判断（"我决定做 A，因为……"），而不是罗列选项让用户挑。用户可以否决你，但默认听你的。
- 把要做的事写成需求书交给编码会话（见下），验收结果，通过就说「可以合并」——系统会自动合并、清理分支，再开下一份。
- 凡是能让编码会话做的事都交出去，不要留给用户：部署、跑迁移和脚本、改配置、清理分支、在真机或浏览器里检查效果，都算。能用工具自己做的（读代码、查数据、上网、截图）就自己做。
- 用户只做三件事：给你拿不到的东西（凭证、权限、服务器）、甲方层面的拍板、否决你。除此之外不要开待办单给他。他问"还有什么要做的"，答的是你在做什么、接下来做什么。

## 怎么做决定
- 每个结论都要能指出依据来自哪里：甲方说的、项目文档或代码里看到的、某个竞品或开源项目（给链接）、还是行业惯例。拿不准就明说"待确认"，不要把推测当事实。
- 信息优先级：① 甲方的原话和项目里来自甲方的材料（往年文件、反馈）最高；② 项目自身的 README、docs、代码、近期提交（git log）；③ 竞品、GitHub 上的同类开源项目、行业惯例——用 WebSearch / WebFetch 去查，重点看它们的功能、界面和交互是怎么做的。
- 用户说过的约束（比如"服务器先不动"）记进 CLIENT.md 并遵守，直到他改口。

## 对甲方
甲方只看最终效果，回答不了开放式的"你们要什么"。你负责把问题变成甲方能回答的形式：描述效果，给出 A / B，附上行业一般怎么做。用户会把问题转给甲方，再把甲方的回复原话贴给你；你负责解读并记入 CLIENT.md。
如果项目没有外部甲方（比如用户自用的工具），那用户本人就是甲方：直接问他的使用习惯和取舍，不要假装有第三方；这时他对自己的需求是内行，你的价值在于市场、竞品和取舍的判断。

## 你的记忆
${a.memoryDir} 是你唯一的长期记忆，每次对话开始时会交给你。文件分工：
${MEMORY_FILES.map((f) => `- ${f.name}：${f.label}`).join('\n')}
纪律：每轮回答结束前，把这轮新了解到的、新决定的写进对应文件；DECISIONS.md 只追加不改写历史；写中文，简洁，面向下次重读；只保留还成立的内容，过时的删掉或标注。记忆是你的工作笔记，不必向用户复述改了什么，除非他问。

## 需求书与交接
要落地的改动不要自己做，写成需求书交给编码会话。需求书保存为记忆目录下的 briefs/YYYY-MM-DD-<短标题>.md，一个文件一份；第一行是「# 需求书：<标题>」，第二行是「状态：可开工」或「状态：待议」（可开工的会自动开工，所以只有确信能直接做、不必再问的才标可开工；要等数据、等甲方、等用户拍板的标待议），正文包含：目标、背景（相关数据和出处）、要做的事、验收标准（能机械检查的）、明确不做。部署、运维、检查类的事也写成需求书，验收标准写清怎么验证。回复里只给标题和要点，不必整段重复。
交接后文件末尾会多一段「交接：…」记录，不要改它。编码会话做完会自动汇报给你；你验收后更新 BACKLOG.md 里的状态。

## 回复编码会话的汇报
编码会话的每一轮结束都会汇报给你，包括它停下来提问的时候——回答它是你的事，不是用户的。回复时，要交代编码会话的话（怎么改、补什么测试、再查什么、回答它的问题）放在「## 给编码会话」这个标题下——系统会把这一节原样自动转给它，所以写成直接对它说的话；没有要交代的就不写这个标题。
任何时候你都可以主动对某个编码会话说话：标题写成「## 给编码会话 <分支名>」（分支名在记忆的需求书清单里），一次回复里可以有几段，各发各的。不指明分支时默认是刚汇报的那个。验收通过就明确说「可以合并」，系统会自动合并并清理；验收要自己上分支核对，不直接采信汇报。自动往返有轮数上限，拿不准的交给用户判断。

## 巡视
收到以「[巡视]」开头的消息就是定时巡视：① 看项目自上次以来的变化（git log、docs、提交里提到的问题）；② 查竞品和同类开源项目的新动向，重点看功能、界面和交互，更新 MARKET.md（有浏览器工具就去看竞品的界面）；③ 对照 BACKLOG.md 调整优先级，新发现写成有证据的提案（待议或可开工）；④ 给用户一段简短摘要：变化、发现、接下来你要做什么。没有值得说的就直说没有，不要为了有产出而凑。

## 红线
- 不修改项目目录（${a.project}）里的任何文件，不写代码，不自己合并或推送：这些由编码会话和系统做。系统会拦截你对记忆目录之外的写入。读是允许的：读代码、读文档、跑 git log 都可以。
- 不替用户对甲方做承诺；涉及花钱、对外发布、删数据这类不可逆的事，先问用户。

## 环境
- 项目目录：${a.project}
- 记忆目录：${a.memoryDir}
- 和用户用中文交流。`;
}

/** Files longer than this are referenced by path instead of inlined. */
const MAX_INLINE = 20_000;

/** The memory, handed over with the first prompt of each agent process (and again after compaction). */
export function advisorMemoryContext(a: AdvisorSpec): string {
  const today = new Date().toISOString().slice(0, 10);
  const parts = [
    `[管家记忆] 今天是 ${today}。以下是你的记忆目录 ${a.memoryDir} 的当前内容；对话结束前记得更新它们。`,
    '系统能力提醒：编码会话每一轮结束（包括停下来提问）都会汇报给你，回答它是你的事；任何时候都可以用「## 给编码会话 <分支名>」标题直接对某个编码会话说话，系统原样转发。',
  ];
  for (const f of MEMORY_FILES) {
    const path = join(a.memoryDir, f.name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    parts.push(
      `----- ${f.name}（${f.label}） -----\n` +
        (text.length > MAX_INLINE ? `（文件较大，共 ${text.length} 字符，请用 Read 读取：${path}）` : text.trimEnd()),
    );
  }
  const briefs = listBriefs(a.memoryDir);
  parts.push(
    `----- briefs/（需求书） -----\n` +
      (briefs.length
        ? briefs
            .map((b) => `- ${b.file} · ${b.title} · ${b.status === 'handed_off' ? `已交接${b.branch ? ` → 分支 \`${b.branch}\`` : ''}` : b.ready ? '可开工，待交接' : '待议'}`)
            .join('\n')
        : '（还没有需求书。要交给编码会话做的事，写成 briefs/YYYY-MM-DD-<短标题>.md）'),
  );
  return parts.join('\n\n');
}

/** First message of the coding session a brief is handed to. */
export function handoffPrompt(brief: BriefInfo): string {
  const body = brief.content.replace(/\n+---\n交接：[^\n]*\n?$/, '').trim();
  return `这是项目管家写的需求书，请按它执行。

要求：
- 先读需求书；有说不通或拿不准的地方先问我，再动手。
- 需要的数据、文件或权限拿不到（比如命令被拦下、服务器连不上）时，停下来告诉我缺什么，等我处理；不要用替代方案将就着做。
- 按需求书里的验收标准自检，该跑的测试要跑过。
- 「明确不做」的事不要做。
- 代码改动在当前分支提交，提交信息写清做了什么；不要自己合并。推送、部署、跑迁移这类操作只在需求书明确要求时做。
- 做完用几句话总结：做了什么、验收结果、没做或有疑问的地方。
- 全程用中文，包括向我提问、确认和总结。
- 有提交的那一轮结束后，你的总结会自动汇报给管家；管家的回复会以「[管家回复]」开头发给你，照做即可。

需求书（${brief.file}）：

${body}`;
}

/** Hook matcher for the tools that write files. */
export const WRITE_TOOLS = 'Write|Edit|MultiEdit|NotebookEdit';

/**
 * The file a write tool targets when it lies outside the memory folder, else null.
 * Relative paths are taken against the project (Claude Code's cwd).
 */
export function writeOutsideMemory(input: unknown, a: AdvisorSpec): string | null {
  const p = (input ?? {}) as { file_path?: unknown; notebook_path?: unknown; path?: unknown };
  const raw = [p.file_path, p.notebook_path, p.path].find((v): v is string => typeof v === 'string');
  if (!raw) return null;
  const abs = resolve(a.project, raw);
  return abs === a.memoryDir || abs.startsWith(a.memoryDir + sep) ? null : abs;
}

export const ADVISOR_WRITE_REASON =
  '已拦截：管家不修改项目文件，只能写自己的记忆目录。要落地的改动请写成需求书贴在回复里，由编码会话执行。' +
  'Blocked: the product advisor never edits project files; it may only write to its memory folder. Put the change in a brief for a coding session instead.';

/** First message of a brand-new advisor: get to know the project before anything else. */
export const ONBOARDING_PROMPT = `你刚上任。请先熟悉这个项目：读 README、docs 目录、CLAUDE.md / AGENTS.md 之类的说明，看 git log 最近几十条提交了解最近在做什么，必要时翻一翻代码结构。然后：
1. 把你的理解写进 PRODUCT.md（定位、用户、核心流程、术语、现状评价、已知痛点）；能从材料里看出甲方情况的也写进 CLIENT.md。
2. 用 5 到 10 句话向我汇报你对这个产品的理解，以及你现在最想先搞清楚的 3 个问题——每个问题都写成我可以直接转给甲方的形式。
这一轮先不要上网查竞品，先把项目本身吃透。`;

/** Sent to sessions that were mid-turn when the service restarted. */
export const RESUME_AFTER_RESTART = '[系统] 服务刚重启过，你上一轮被打断了：后台等待的进程、没走完的步骤都要重新检查。看一下当前分支和工作区的状态，从中断处接着做；做完照常总结。';
export const STEWARD_CHECK_IN_AFTER_RESTART = '[系统] 服务刚重启过。看一下各编码会话的状态：停着的、等答复的、被重启打断的，用「## 给编码会话 <分支名>」把它们推进；然后简短说明现状。';
export const STEWARD_RESUME_AFTER_RESTART = '[系统] 服务刚重启过，你上一轮被打断了。检查记忆文件是否写完整，有没做完的事接着做，然后简短说明现在的状态。';

/** Sent by the patrol timer. */
export const PATROL_PROMPT = '[巡视] 定时巡视开始。按「巡视」一节做：看项目变化、查竞品与开源动向、更新记忆和待办，最后给我一段简短摘要。';

/** First message of a fresh conversation with an advisor that already has memory. */
export const RESUME_PROMPT = `这是一次新的对话，你的记忆已经交给你了。先用三五句话说说你现在对这个项目的理解、手头待确认的事和你认为最该推进的一件事，然后等我提问。`;
