import type { AccountSpec } from './account.js';
import type { AdvisorSpec } from './advisor.js';
import type {
  AgentEvent,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  LiveDelta,
  PermissionAnswer,
  SessionOptions,
} from '../shared/protocol.js';

/** An uploaded file handed to the agent with a message. */
export interface FileRef {
  name: string;
  mime: string;
  path: string;
}

export interface AgentHost {
  cwd: string;
  /** Where this session's uploads are stored; agents may read from it. */
  uploadsDir: string;
  options: SessionOptions;
  /** Agent-side session/thread id to resume, if any. */
  resumeId: string | null;
  /** Set when the session is the project's product advisor: role prompt, memory folder, write guard. */
  advisor?: AdvisorSpec;
  /**
   * Set for sessions of member accounts: their folder and memory, and none of the machine owner's
   * personal Claude / Codex setup. Unset for admins, who run with this machine's own setup.
   */
  account?: AccountSpec;
  /** Persist and broadcast an event. */
  emit(event: AgentEvent): void;
  /** Broadcast a streaming delta without persisting it. */
  delta(delta: LiveDelta): void;
  /** The agent finished all queued work and is waiting for input. */
  idle(): void;
  /** The agent is blocked on a permission request (true) or no longer (false). */
  waiting(on: boolean): void;
}

export interface AgentRunner {
  /** Queue a user message; starts a turn if idle. */
  send(text: string, files?: FileRef[]): void;
  interrupt(): Promise<void>;
  answerPermission(answer: PermissionAnswer): boolean;
  setPermissionMode?(mode: ClaudePermissionMode): Promise<void>;
  /** Takes effect from the next model call (Claude) or the next turn (Codex). */
  setEffort?(effort: EffortLevel | null): Promise<void>;
  setApprovalPolicy?(policy: CodexApprovalPolicy): Promise<void>;
  /** Codex: applied from the next turn. */
  setSandboxMode?(mode: CodexSandboxMode): void;
  /** null = the CLI's own default model. Takes effect from the next model call / turn. */
  setModel?(model: string | null): Promise<void>;
  /** Summarise the conversation to free context; only while idle. */
  compact?(): Promise<void>;
  /** Stop the underlying process. Safe to call more than once. */
  close(): void;
  readonly busy: boolean;
}

export const MAX_OUTPUT = 20_000;

export function truncate(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? `${s.slice(0, max)}\n… [已截断，共 ${s.length} 字符]` : s;
}

/** Text to send with the message: names and paths of attached files the agent should open itself. */
/**
 * `inline`: files handed to the model directly with the message (images, and PDFs for members' Claude).
 * `remote`: the session works on a member's computer: the files are on this server, reached through
 * the remote tools rather than read from a path.
 */
export function describeFiles(text: string, files: FileRef[], inline: (f: FileRef) => boolean, remote = false): string {
  const listed = files.filter((f) => !inline(f));
  const shown = files.filter(inline);
  const parts = [text.trim() || '请查看附件。'];
  if (shown.length) parts.push(`（附带 ${shown.length} 个文件，内容已经直接给你：${shown.map((f) => f.name).join('、')}）`);
  if (listed.length) {
    const head = remote
      ? '附件（存在服务器上，不在他的电脑上。文本、代码、日志、PDF 用 read_attachment 读；要放到他电脑上、或者要在他电脑上用工具打开的（压缩包、Word、Excel 等），用 send_attachment 传过去）：'
      : '附件（可以直接读取这些文件）：';
    parts.push([head, ...listed.map((f) => `- ${f.name}: ${f.path}`)].join('\n'));
  }
  return parts.join('\n\n');
}
