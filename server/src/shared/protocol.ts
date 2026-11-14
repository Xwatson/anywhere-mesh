// Types shared by the server and the web client. Type-only: no runtime code here.

export type AgentKind = 'claude' | 'codex';

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/** When Codex asks before acting: on-request = when it needs to leave the sandbox. */
export type CodexApprovalPolicy = 'on-request' | 'untrusted' | 'never';

export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface SessionOptions {
  model?: string;
  /** Reasoning effort; unset means the CLI's own default/config. */
  effort?: EffortLevel;
  /** Claude only. */
  permissionMode?: ClaudePermissionMode;
  /** Codex only. */
  sandboxMode?: CodexSandboxMode;
  /** Codex only. */
  approvalPolicy?: CodexApprovalPolicy;
}

export type SessionStatus = 'idle' | 'running' | 'waiting';

/** A session's role besides plain coding: 'advisor' = the project's steward (管家). */
export type SessionRole = 'advisor';

export interface SessionInfo {
  id: string;
  /** The account the session belongs to; other accounts never see it. */
  userId: number;
  title: string;
  agent: AgentKind;
  cwd: string;
  agentSessionId: string | null;
  options: SessionOptions;
  status: SessionStatus;
  /** Git repository root (or cwd) the session belongs to, for grouping; symlinks resolved. */
  project: string;
  /** Path of cwd relative to `project` ('' at the root), since cwd may be a symlinked path. */
  subdir: string;
  /** False when cwd is outside WORKSPACE_ROOTS: history is viewable but the agent cannot run. */
  inWorkspace: boolean;
  /** Set when the session works in its own git worktree. */
  worktree?: { branch: string; base: string; repo: string; exists: boolean };
  /** A member's session: its project folder on the member's own computer (where the agent works). */
  remoteCwd?: string;
  /** Set when the session is the project's product advisor rather than a coding session. */
  role?: SessionRole;
  /** Set when the session was started from a product advisor's brief. */
  brief?: { file: string; advisorId: string };
  createdAt: number;
  updatedAt: number;
}

/** A file the user attached to a message; stored on the server under the session. */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface TodoEntry {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect?: boolean;
  /** The answer is sensitive (a password, a token): typed hidden. */
  secret?: boolean;
  options: { label: string; description?: string }[];
}

/**
 * Agent-neutral event model. Events with the same `id` (tool_call) are updates
 * of one item; the client keeps the latest.
 */
export type AgentEvent =
  | { type: 'user_message'; text: string; attachments?: Attachment[] }
  | { type: 'assistant_text'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
      status: 'running' | 'completed' | 'failed';
      output?: string;
    }
  | {
      type: 'permission_request';
      id: string;
      toolName: string;
      input: unknown;
      title?: string;
      reason?: string;
      questions?: QuestionSpec[];
    }
  | { type: 'permission_resolved'; id: string; allow: boolean; note?: string }
  | { type: 'todo'; items: TodoEntry[] }
  | { type: 'session_info'; agentSessionId: string; model?: string }
  | {
      type: 'turn_end';
      ok: boolean;
      error?: string;
      durationMs?: number;
      costUsd?: number;
      usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
    }
  | { type: 'notice'; level: 'info' | 'error'; text: string }
  /** The advisor wrote or changed a brief, or it was handed to a coding session; one per file, the latest wins. */
  | { type: 'brief'; file: string; title: string; status: 'new' | 'handed_off'; ready?: boolean; sessionId?: string; branch?: string }
  /** Current context size in tokens, from usage the agent already reported (no extra requests). */
  | { type: 'context'; used: number; window?: number };

export interface StoredEvent {
  seq: number;
  ts: number;
  event: AgentEvent;
}

/** A slice of a session's history, newest last. */
export interface EventPage {
  events: StoredEvent[];
  /** Seq where the slice starts; older pages are requested before it. */
  firstSeq: number;
  /** Older events exist before firstSeq. */
  hasMore: boolean;
}

/** The product advisor's memory files, as shown in the memory panel. */
export interface AdvisorMemory {
  dir: string;
  files: { name: string; label: string; content: string; updatedAt: number }[];
}

/** A brief (需求书) the advisor wrote for a coding session, and whether it was handed off yet. */
export interface BriefInfo {
  /** File name inside the advisor's briefs folder. */
  file: string;
  title: string;
  status: 'new' | 'handed_off';
  /** Marked 「状态：可开工」 by the advisor: may be handed off automatically. */
  ready: boolean;
  /** The coding session it was handed to. */
  sessionId?: string;
  branch?: string;
  updatedAt: number;
  content: string;
}

/** Per-project automation settings of the product advisor (DATA_DIR/advisors/<project>/settings.json). */
export interface AdvisorSettings {
  /** Hand off briefs marked 可开工 without being asked. */
  autoHandoff: boolean;
  /** Coding sessions from briefs allowed at the same time (not merged, not deleted). */
  maxConcurrent: number;
  /** Automatic hand-offs per 24 hours. */
  dailyLimit: number;
  /** Pause automation while a Claude usage window is at or above this percentage. */
  quotaStopPercent: number;
  /** Periodic patrol: the advisor looks at the project, competitors and its backlog by itself. */
  patrol: boolean;
  patrolHours: number;
  /** Merge a brief's branch as soon as the advisor says 可以合并 (clean branch, no conflicts). */
  autoMerge: boolean;
  /** After a merge, remove the worktree and its branch (the session stays as history). */
  cleanupAfterMerge: boolean;
}

/** Where one brief stands, for the advisor's progress overview. */
export type ProgressStage = 'pending' | 'ready' | 'working' | 'waiting_user' | 'approved' | 'merged' | 'orphaned';

export interface ProgressItem {
  file: string;
  title: string;
  stage: ProgressStage;
  sessionId?: string;
  sessionStatus?: SessionStatus;
  branch?: string;
  /** Commits on the branch beyond its base. */
  commits?: number;
  updatedAt: number;
}

export interface Progress {
  items: ProgressItem[];
  /** One line for the user: what needs them, what is running, what is queued. */
  summary: string;
  /** Items that need the user right now. */
  attention: number;
}

/** Live-only stream deltas; never persisted. */
export interface LiveDelta {
  kind: 'text' | 'tool_output';
  /** For tool_output: the tool_call id. */
  id?: string;
  text: string;
}

export type PermissionAnswer = {
  requestId: string;
  allow: boolean;
  /** Remember this decision for the rest of the session (Claude). */
  always?: boolean;
  /** Answers for AskUserQuestion, keyed by question text. */
  answers?: Record<string, string>;
  message?: string;
};

export type ClientMessage =
  | { t: 'sub'; sessionId: string; afterSeq: number }
  | { t: 'unsub'; sessionId: string }
  | { t: 'send'; sessionId: string; text: string; attachments?: string[] }
  | { t: 'interrupt'; sessionId: string }
  | { t: 'compact'; sessionId: string }
  | ({ t: 'perm'; sessionId: string } & PermissionAnswer)
  | { t: 'mode'; sessionId: string; mode: ClaudePermissionMode }
  | { t: 'effort'; sessionId: string; effort: EffortLevel | null }
  | { t: 'approval'; sessionId: string; policy: CodexApprovalPolicy }
  | { t: 'sandbox'; sessionId: string; mode: CodexSandboxMode }
  | { t: 'model'; sessionId: string; model: string | null }
  | { t: 'term.attach'; termId: string }
  | { t: 'term.detach'; termId: string }
  | { t: 'term.in'; termId: string; data: string }
  | { t: 'term.resize'; termId: string; cols: number; rows: number }
  | { t: 'ping' };

export type ServerMessage =
  /** `page` is set on the first load: only the newest part of the history was sent. */
  | { t: 'events'; sessionId: string; events: StoredEvent[]; page?: { firstSeq: number; hasMore: boolean } }
  | { t: 'delta'; sessionId: string; delta: LiveDelta }
  | { t: 'session'; session: SessionInfo }
  | { t: 'session.deleted'; sessionId: string }
  /** Admins only: another account's session was created or changed (admins watch them, read-only). */
  | { t: 'others'; session: OtherSession }
  | { t: 'others.deleted'; sessionId: string }
  /** The session's event log was rebuilt; clients must drop their copy and resubscribe. */
  | { t: 'reset'; sessionId: string }
  | { t: 'term.out'; termId: string; data: string }
  | { t: 'term.exit'; termId: string; code: number }
  | { t: 'pong' }
  | { t: 'error'; message: string; sessionId?: string };

/** Another account's session, as admins see it: read-only. */
export interface OtherSession extends SessionInfo {
  /** The account it belongs to. */
  owner: string;
  /** That account is a member: the session works on the member's own computer. */
  member: boolean;
}

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  command: string;
  createdAt: number;
  exited: boolean;
}

/** A Claude Code or Codex session found in the agent's own local history. */
export interface ExternalSession {
  agent: AgentKind;
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** Where it was started: cli, vscode, exec, … */
  source: string;
  gitBranch?: string;
  project: string;
  subdir: string;
  /** Our session id when it is already linked to a web session. */
  importedAs?: string;
}

export interface UsageWindow {
  label: string;
  usedPercent: number;
  /** Epoch ms, when known. */
  resetsAt?: number;
  /** Human-readable reset time as the CLI printed it. */
  resetsText?: string;
}

export interface AgentUsage {
  ok: boolean;
  error?: string;
  plan?: string;
  windows: UsageWindow[];
  /** Extra detail lines (e.g. Codex credits). */
  notes?: string[];
  fetchedAt: number;
}

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  /** Empty when the model has no adjustable reasoning effort. */
  efforts: EffortLevel[];
  defaultEffort?: EffortLevel;
  isDefault?: boolean;
}

export interface AgentModels {
  claude: { models: ModelOption[] };
  codex: { models: ModelOption[]; configuredEffort?: string; configuredModel?: string };
}

export interface UsageInfo {
  claude: AgentUsage;
  codex: AgentUsage;
}

// ---- git (web commit / push / pull request) ----

export interface GitFile {
  path: string;
  /** Previous path of a rename. */
  from?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
  /** Already in the index. */
  staged: boolean;
}

export type GitInfo =
  | { isGit: false }
  | {
      isGit: true;
      root: string;
      /** null when HEAD is detached. */
      branch: string | null;
      head: string | null;
      upstream: string | null;
      /** Commits not yet on the upstream (or on no remote branch at all, before the first push). */
      ahead: number;
      behind: number;
      remote: string | null;
      defaultBranch: string;
      files: GitFile[];
      /** user.name / user.email as git resolves them for this repository. */
      identity: { name: string; email: string } | null;
      /** Author of the latest commit, offered when no identity is configured. */
      suggestedIdentity: { name: string; email: string } | null;
      lastSubject: string | null;
      /** The hosting site's page for opening a pull request from this branch. */
      prUrl: string | null;
      /** GitHub CLI is installed and logged in, so pull requests can be created directly. */
      gh: boolean;
    };

/** A session's worktree compared with the branch it came from. */
export interface WorktreeStatus {
  branch: string;
  base: string;
  path: string;
  /** The directory is still there. */
  exists: boolean;
  branchExists: boolean;
  /** Commits on the task branch that the base does not have, and the reverse. */
  ahead: number;
  behind: number;
  /** Uncommitted changes to tracked files. */
  dirty: boolean;
  /** Untracked files (lost when the worktree is removed). */
  untracked: boolean;
}

/** A folder on a member's computer and its subfolders, for choosing a session's project there. */
export interface RemoteListing {
  path: string;
  parent: string | null;
  isGit: boolean;
  dirs: string[];
}

/** An account as the admin page lists it. */
export interface AccountInfo {
  id: number;
  username: string;
  isAdmin: boolean;
  /** A member's folder here (its memory); null for admins, who work in the whole workspace. */
  home: string | null;
  /** A member's own computer, where its agents work (over SSH); null when not set yet (and for admins). */
  remote: { host: string; port: number | null } | null;
  createdAt: number;
  lastLoginAt: number | null;
  sessions: number;
  /** Sessions whose agent is working right now (deleting the account stops them). */
  busySessions: number;
  /** Browsers that get this account's push notifications. */
  pushDevices: number;
}

/** A link that lets anyone who has it (and its password, when set) read a session, until it expires. */
export interface ShareInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  hasPassword: boolean;
  /** Viewers also see what happens after the link was made; otherwise the conversation as it was then. */
  live: boolean;
}

/** A shared session as the people with the link see it (no login, read-only). */
export interface SharedSession {
  title: string;
  agent: AgentKind;
  role?: SessionRole;
  /** The account that shared it. */
  owner: string;
  /** The project folder's name. */
  project: string;
  /** Where the agent works, for showing the paths in tool calls relative to it. */
  cwd: string;
  /** Live links: whether the agent is working right now (snapshots are always idle). */
  status: SessionStatus;
  live: boolean;
  createdAt: number;
  expiresAt: number;
}

/** A member's account memory, loaded by its Claude and Codex sessions. */
export type AccountMemory = { available: false } | { available: true; path: string; content: string; updatedAt: number };

/** The service process, for the restart button. */
export interface SystemInfo {
  /** systemd unit running the service; null when started by hand (no restart button). */
  unit: string | null;
  startedAt: number;
  pid: number;
  /** server/dist was rebuilt after this process started: a restart applies it. */
  rebuiltSinceStart: boolean;
  /** Source files are newer than the last build. */
  unbuiltChanges: boolean;
  /** Sessions whose agent is working right now (a restart interrupts them). */
  busySessions: number;
  /** Those sessions, every account's (missing from a server started before this was added). */
  running?: { owner: string; title: string; mine: boolean }[];
}
