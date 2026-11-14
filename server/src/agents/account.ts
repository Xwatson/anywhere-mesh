// What the agents of a member account get: no tool for this machine at all. They work on the
// member's own computer through the remote MCP server (remote/mcp.ts: run commands, read / write /
// edit files, attachments, memory), and nothing of the machine owner's own Claude / Codex setup
// (CLAUDE.md, settings, plugins, MCP servers, connectors, memories) is loaded for them.
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { RemoteTarget } from '../remote/ssh.js';

export interface AccountSpec {
  username: string;
  /** The member's folder on this machine: only its memory lives here. */
  home: string;
  /** <home>/AGENTS.md: loaded with every session, kept up to date by the agent through the memory tools. */
  memoryFile: string;
  /** The member's computer, where all the work happens. */
  remote: RemoteTarget;
  /** The session's project: a folder on that computer, where `run` starts (unset: the home folder). */
  projectDir?: string;
}

const where = (a: AccountSpec) => `${a.remote.host}${a.remote.port ? `（端口 ${a.remote.port}）` : ''}`;

/** Longer memories are cut here in the prompt. */
const MAX_INLINE = 20_000;

/** Added to the system prompt (Claude) or developer instructions (Codex) of every member session. */
export function accountPrompt(a: AccountSpec): string {
  let memory = '';
  try {
    memory = readFileSync(a.memoryFile, 'utf8').trim();
  } catch {
    /* not written yet */
  }
  const body = !memory
    ? '（还是空的）'
    : memory.length > MAX_INLINE
      ? `${memory.slice(0, MAX_INLINE)}\n\n（记忆较长，后面还有 ${memory.length - MAX_INLINE} 个字符没放进来；找机会用 memory_write 整理精简）`
      : memory;
  return `# 你的工作环境

你在为 Anywhere Coding 的账号「${a.username}」工作。${a.username} 的电脑是 ${where(a)}，你通过 SSH 操作它：所有工作都在那台电脑上做。
你自己运行在另一台服务器上，那台服务器不归这个账号使用：你没有操作它的工具，也不要试图在上面执行命令或读写文件。
${
  a.projectDir
    ? `这个会话的项目在他电脑上的 ${a.projectDir}：run 一开始就在这个目录里，相对路径也从这里算。开始做事前先看一眼这个目录，项目里有 AGENTS.md / CLAUDE.md / README 之类的说明就先读（它们不会自动加载给你）。`
    : '这个会话没有指定项目目录，从他的主目录开始；要做的项目在哪，问他或者看记忆。'
}

你能用的工具（remote）：
- run：在他的电脑上执行命令，用法和终端一样：cd 之后的工作目录会一直保留；搜索代码就用 rg / grep / find。不是交互式终端，也不加载登录配置（需要 nvm 等时用 zsh -lic "…" 或 bash -lc "…"）；要传入的内容可以放进 stdin 参数。开发服务器、watch 这类不会自己结束的命令设 run_in_background，之后看它的日志。
- read_file / write_file / edit_file：读、写、改他电脑上的文件，相对路径从 run 当前的工作目录算。
- apply_patch：用 Codex 的补丁格式一次改多个文件。如果你自带 apply_patch，那个改的是服务器上的文件，会被拒绝——改他电脑上的文件一律用这里的 apply_patch（格式完全一样）、edit_file 或 write_file。
- read_attachment / send_attachment：读用户在网页上传的附件，或者把附件传到他的电脑上。
- memory_edit / memory_write：更新下面这份记忆。
第一次连上时先确认他电脑的系统和 shell（uname -a；Windows 用 ver），记进记忆。
记忆或资料里如果写着「ssh 某地址 '命令'」，那是从服务器连过去的写法：用 run 时直接写引号里的命令，不要再套一层 ssh。
他的电脑连不上时，告诉用户检查电脑是否开机、是否在线，不要换别的办法绕过。

## 记忆
这份记忆每个会话开始时都会交给你（当前内容在下面），Claude 和 Codex 共用。
- 了解到以后还用得上的东西时，用 memory_edit 更新它：他电脑上的环境（系统、shell、工具版本、项目所在目录）、他的偏好和习惯、纠正过你的地方、项目背景和重要决定。他说「记住……」时一定要记下来。
- 按标题归类，写得简洁；过时的改掉或删掉，不要一直往后追加；乱了就用 memory_write 整理。不要写密码、密钥、令牌。
- 只在确实有值得记的东西时更新，不必每轮都改，也不用向用户复述改了什么（除非他问）。

----- AGENTS.md -----
${body}`;
}

/** How Claude Code / Codex start the remote MCP server for one session. */
export function remoteMcpLaunch(a: AccountSpec, uploadsDir: string): { command: string; args: string[] } {
  // Under tsx (development) this module is TypeScript and so is the server: load it with tsx.
  const dev = import.meta.url.endsWith('.ts');
  const script = fileURLToPath(new URL(`../remote/mcp.${dev ? 'ts' : 'js'}`, import.meta.url));
  // Shared SSH connections: one handshake per session rather than per call.
  const cfg = {
    host: a.remote.host,
    port: a.remote.port ?? null,
    label: `${a.username} 的电脑`,
    memoryFile: a.memoryFile,
    uploadsDir,
    controlDir: join(config.dataDir, 'ssh'),
    startCwd: a.projectDir ?? null,
    // Test setups only (e.g. a scratch known_hosts): Codex starts MCP servers without our environment.
    ...(process.env.ANYWHERE_SSH_OPTS && { sshOpts: process.env.ANYWHERE_SSH_OPTS }),
  };
  return {
    command: process.execPath,
    args: [...(dev ? ['--import', import.meta.resolve('tsx')] : []), script, Buffer.from(JSON.stringify(cfg)).toString('base64')],
  };
}

// ---- Claude ----

/**
 * The only built-in Claude Code tools a member keeps: none of them touches this machine. (Not ToolSearch:
 * with it Claude Code defers MCP tools, and the remote tools are the ones every turn needs.)
 */
export const MEMBER_CLAUDE_TOOLS = ['TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'WebSearch', 'WebFetch'];

/** Built-in names the model may still reach for out of habit: the same work, on the member's computer. */
export const MEMBER_TOOL_ALIASES: Record<string, string> = {
  Bash: 'mcp__remote__run',
  Read: 'mcp__remote__read_file',
  Write: 'mcp__remote__write_file',
  Edit: 'mcp__remote__edit_file',
};

/** Addresses of this machine and the local networks (loopback, private, link-local, CGNAT, ULA). */
function privateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168);
  }
  const l = ip.toLowerCase();
  return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
}

/** Why a member may not fetch this URL (it would reach this machine or the local network), or null. */
async function urlProblem(raw: unknown): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return null; // the tool reports bad URLs itself
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = '不能访问服务器本机或内网地址。需要访问他电脑上的服务时，用 run 在他的电脑上执行 curl。';
  if (/^(localhost|.*\.(localhost|local|lan|internal|home|arpa))$/i.test(host)) return local;
  if (isIP(host)) return privateAddress(host) ? local : null;
  const addrs = await lookup(host, { all: true }).catch(() => []);
  return addrs.some((r) => privateAddress(r.address)) ? local : null;
}

/** Why a member's agent may not use this tool, or null. Checked for every tool call, in every permission mode. */
export async function memberToolProblem(tool: string, input: unknown): Promise<string | null> {
  if (tool.startsWith('mcp__remote__') || Object.hasOwn(MEMBER_TOOL_ALIASES, tool)) return null;
  if (!MEMBER_CLAUDE_TOOLS.includes(tool)) {
    return `已拦截：这个账号只能操作它自己的电脑，「${tool}」会在服务器本机上运行，不能用。请改用 remote 工具（run、read_file、write_file、edit_file）在他的电脑上做。`;
  }
  if (tool === 'WebFetch') return urlProblem((input as { url?: unknown } | null)?.url);
  return null;
}

// ---- Codex ----

/** Codex features that reach the machine owner's own memories, ChatGPT apps, browser and desktop. */
const OWNER_CODEX_FEATURES = ['memories', 'external_agent_memory_import', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use'];

/**
 * Codex's own tools that act on this machine: its shell, image viewing, sub-agents. (The code-mode
 * runtime stays: it is how Codex reaches MCP tools, and it has no file, process or network access of
 * its own. apply_patch stays listed, but the sandbox is read-only and its write requests are refused.)
 */
const LOCAL_CODEX_FEATURES = ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'image_generation', 'goals'];

/** MCP servers of the owner's Codex config: their tools act with the owner's credentials. */
function ownerCodexMcpServers(): string[] {
  let text = '';
  try {
    text = readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const m of text.matchAll(/^\s*\[mcp_servers\.(?:"([^"\]]+)"|([^\].\s]+))\]\s*$/gm)) names.add(m[1] ?? m[2]);
  return [...names].filter((n) => n !== 'remote');
}

/** `-c` overrides for a member's Codex app-server process (each session has its own). */
export function codexAccountConfig(a: AccountSpec, uploadsDir: string): string[] {
  const servers = ownerCodexMcpServers();
  // `-c` keys are dotted paths: a server whose name is not a bare TOML key cannot be switched off, so refuse to start.
  const odd = servers.filter((n) => !/^[A-Za-z0-9_-]+$/.test(n));
  if (odd.length) throw new Error(`本机 Codex 配置里的 MCP 服务器「${odd.join('、')}」无法为成员账号关闭，请改成只含字母、数字、_ 和 - 的名字`);
  const mcp = remoteMcpLaunch(a, uploadsDir);
  return [
    ...[...OWNER_CODEX_FEATURES, ...LOCAL_CODEX_FEATURES].map((f) => `features.${f}=false`),
    ...servers.map((n) => `mcp_servers.${n}.enabled=false`),
    // The memory comes with the developer instructions; AGENTS.md in the session folder is not read again.
    'project_doc_max_bytes=0',
    `mcp_servers.remote.command=${JSON.stringify(mcp.command)}`,
    `mcp_servers.remote.args=${JSON.stringify(mcp.args)}`,
    'mcp_servers.remote.startup_timeout_sec=30',
    // Long builds and test runs on the member's computer (run allows up to 30 minutes).
    'mcp_servers.remote.tool_timeout_sec=1900',
  ];
}
