import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ClaudeRunner } from './agents/claude.js';
import { CodexRunner } from './agents/codex.js';
import type { AgentHost, AgentRunner } from './agents/types.js';
import { account, ensureHome, homeOf, MEMORY_FILE, rootsOfId } from './accounts.js';
import type { AccountSpec } from './agents/account.js';
import { advisorDir, listBriefs } from './advisors.js';
import { db } from './db.js';
import { externalMark, externalTitle } from './external/history.js';
import { inWorkspace, projectOf, safeDir, subdirOf } from './files.js';
import { pushUser } from './push.js';
import type { WorktreeMeta } from './worktrees.js';
import { deleteUploads, loadAttachments, uploadDir } from './uploads.js';
import type {
  AgentEvent,
  AgentKind,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  EventPage,
  ExternalSession,
  LiveDelta,
  PermissionAnswer,
  ServerMessage,
  SessionInfo,
  SessionOptions,
  SessionRole,
  SessionStatus,
  StoredEvent,
} from './shared/protocol.js';

interface SessionRow {
  id: string;
  user_id: number;
  title: string;
  agent: AgentKind;
  cwd: string;
  agent_session_id: string | null;
  options: string;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  title_auto: number;
  worktree: string | null;
  role: string | null;
  source: string | null;
  loop: string | null;
  remote_cwd: string | null;
}

/** The folder a session is named after until its conversation gives it a title: its project on a member's computer, else its folder here. */
const folderName = (r: { cwd: string; remote_cwd?: string | null }) => basename(r.remote_cwd ?? r.cwd) || r.remote_cwd || r.cwd;

const toInfo = (r: SessionRow): SessionInfo => {
  // A member's session belongs to the project folder on the member's computer.
  const project = r.remote_cwd ?? projectOf(r.cwd);
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    agent: r.agent,
    cwd: r.cwd,
    agentSessionId: r.agent_session_id,
    options: JSON.parse(r.options),
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    project,
    subdir: r.remote_cwd ? '' : subdirOf(r.cwd, project),
    ...(r.remote_cwd && { remoteCwd: r.remote_cwd }),
    // Members can only run sessions in their own folder.
    inWorkspace: inWorkspace(r.cwd, rootsOfId(r.user_id)),
    ...(r.worktree && { worktree: worktreeInfo(JSON.parse(r.worktree) as WorktreeMeta) }),
    ...(r.role === 'advisor' && { role: 'advisor' as const }),
    ...(r.source && { brief: JSON.parse(r.source) as { file: string; advisorId: string } }),
  };
};

const worktreeInfo = (w: WorktreeMeta) => ({ branch: w.branch, base: w.base, repo: w.repo, exists: existsSync(w.path) });

type Listener = (msg: ServerMessage) => void;

/** State of the automatic exchange between an advisor and a coding session (see loop.ts). */
export interface LoopState {
  /** Advisor: the coding session whose report it is answering. */
  pendingRelay?: string;
  /** Coding session: branch head when it last reported, to tell new commits. */
  reportedHead?: string;
  /** Coding session: advisor replies forwarded to it automatically so far. */
  rounds?: number;
  /** Coding session: the advisor said 可以合并. */
  approved?: boolean;
  /** Coding session: its branch was merged (or a PR created) from the web. */
  merged?: boolean;
  /** Advisor: times of automatic hand-offs, for the daily limit. */
  autoHandoffs?: number[];
  /** Advisor: when the patrol last ran. */
  lastPatrolAt?: number;
  /** Advisor: the last reason automatic hand-off waited, so it is not repeated every sweep. */
  lastAutoNote?: string;
}

/** Events per history page; a long session opens with just the newest page. */
const PAGE_SIZE = 100;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 120);

/** A session-list change as the admins watching the account see it (null: nothing for them). */
function forWatchers(userId: number, msg: ServerMessage): ServerMessage | null {
  if (msg.t === 'session.deleted') return { t: 'others.deleted', sessionId: msg.sessionId };
  if (msg.t !== 'session') return null;
  const a = account(userId);
  return a ? { t: 'others', session: { ...msg.session, owner: a.username, member: !a.isAdmin } } : null;
}

/** Owns agent runners and fans their events out to subscribed clients. */
class SessionManager {
  private runners = new Map<string, AgentRunner>();
  private subscribers = new Map<string, Set<Listener>>();
  /** Session-list listeners, each with the account whose sessions it receives. */
  private globalListeners = new Map<Listener, number>();
  /** When each session's current turn started (left idle), for finding what it wrote meanwhile. */
  private runningSince = new Map<string, number>();
  /** Called when a session's turn has ended (status back to idle). */
  private idleListeners = new Set<(info: SessionInfo) => void>();

  /** Sessions that were mid-turn when the service went down; their agents did not survive. */
  readonly interruptedAtStart: string[];

  constructor() {
    // Agents do not survive a server restart; anything mid-turn is now idle.
    this.interruptedAtStart = (db.prepare(`SELECT id FROM chat_sessions WHERE status != 'idle'`).all() as { id: string }[]).map((r) => r.id);
    db.prepare(`UPDATE chat_sessions SET status = 'idle' WHERE status != 'idle'`).run();
    this.fixAutoTitles();
  }

  /**
   * Sessions that still carry their folder name although they already have a
   * conversation: name them after the first message now, then after the agent's own title.
   */
  private fixAutoTitles() {
    const rows = db.prepare('SELECT * FROM chat_sessions WHERE title_auto = 1').all() as unknown as SessionRow[];
    for (const r of rows) {
      if (r.title !== folderName(r)) continue;
      const first = this.events(r.id, 0).find((e) => e.event.type === 'user_message')?.event;
      if (first?.type === 'user_message') this.setAutoTitle(r.id, this.titleFromMessage(first.text, first.attachments));
    }
    const linked = rows.filter((r) => r.agent_session_id);
    void (async () => {
      for (const r of linked) await this.syncTitle(r.id);
    })();
  }

  private titleFromMessage(text: string, attachments?: { name: string }[]): string {
    return oneLine(text) || oneLine((attachments ?? []).map((a) => a.name).join(', '));
  }

  /** Sets a title the user has not chosen; no-op once they rename the session. Does not reorder the list. */
  private setAutoTitle(id: string, title: string) {
    if (!title) return;
    const r = db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ? AND title_auto = 1 AND title != ?').run(title, id, title);
    if (r.changes) this.announce(id);
  }

  /** Follows the title the agent gives the session (Claude's generated title, Codex's thread name or preview). */
  private async syncTitle(id: string) {
    const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
    if (!row?.title_auto || !row.agent_session_id) return;
    const title = await externalTitle(row.agent, row.agent_session_id, row.cwd).catch(() => null);
    if (title) this.setAutoTitle(id, title);
  }

  /** The account's sessions, newest first; without `userId` every account's (for the service's own bookkeeping). */
  list(userId?: number): SessionInfo[] {
    const rows =
      userId === undefined
        ? db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC').all()
        : db.prepare('SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
    return (rows as unknown as SessionRow[]).map(toInfo);
  }

  /** The account a session belongs to (undefined when there is no such session). */
  ownerOf(id: string): number | undefined {
    return (db.prepare('SELECT user_id FROM chat_sessions WHERE id = ?').get(id) as { user_id: number } | undefined)?.user_id;
  }

  get(id: string): SessionInfo | null {
    const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
    return row ? toInfo(row) : null;
  }

  /** The account's current product advisor of the project: its most recently created advisor session, if any. */
  advisorOf(project: string, userId: number): SessionInfo | null {
    const rows = db
      .prepare(`SELECT * FROM chat_sessions WHERE role = 'advisor' AND user_id = ? ORDER BY created_at DESC`)
      .all(userId) as unknown as SessionRow[];
    const real = projectOf(project);
    return rows.map(toInfo).find((s) => s.project === real) ?? null;
  }

  /** Without a title the session is named after its folder until the conversation gives it a better one. */
  create(
    userId: number,
    agent: AgentKind,
    cwd: string,
    title: string | undefined,
    options: SessionOptions,
    agentSessionId?: string,
    worktree?: WorktreeMeta,
    role?: SessionRole,
    source?: { file: string; advisorId: string },
    /** A member's session: its project folder on the member's computer. */
    remoteCwd?: string,
  ): SessionInfo {
    const id = randomUUID();
    const now = Date.now();
    const custom = title?.trim();
    db.prepare(
      `INSERT INTO chat_sessions (id, user_id, title, agent, cwd, agent_session_id, options, status, created_at, updated_at, title_auto, worktree, role, source, remote_cwd)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      custom || folderName({ cwd, remote_cwd: remoteCwd }),
      agent,
      cwd,
      agentSessionId ?? null,
      JSON.stringify(options),
      now,
      now,
      custom ? 0 : 1,
      worktree ? JSON.stringify(worktree) : null,
      role ?? null,
      source ? JSON.stringify(source) : null,
      remoteCwd ?? null,
    );
    const info = this.get(id)!;
    this.announce(id);
    return info;
  }

  /** `agent:agent session id` -> our session and its account, for marking (and keeping apart) already-linked history. */
  linkedIds(): Map<string, { id: string; userId: number }> {
    const rows = db
      .prepare('SELECT id, user_id, agent, agent_session_id FROM chat_sessions WHERE agent_session_id IS NOT NULL')
      .all() as { id: string; user_id: number; agent: string; agent_session_id: string }[];
    return new Map(rows.map((r) => [`${r.agent}:${r.agent_session_id}`, { id: r.id, userId: r.user_id }]));
  }

  /** Creates a web session linked to an existing Claude/Codex session, seeded with its history. */
  importExternal(userId: number, ext: Omit<ExternalSession, 'project' | 'subdir'>, history: AgentEvent[]): SessionInfo {
    const existing = this.linkedIds().get(`${ext.agent}:${ext.id}`);
    if (existing) {
      if (existing.userId !== userId) throw new Error('这个会话已经被另一个账号打开了');
      return this.get(existing.id)!;
    }
    const options: SessionOptions =
      ext.agent === 'claude'
        ? { permissionMode: 'default' }
        : { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' };
    const info = this.create(userId, ext.agent, ext.cwd, ext.title, options, ext.id);
    // Keep following the agent's title (e.g. a rename in the CLI) until the user renames it here.
    db.prepare('UPDATE chat_sessions SET title_auto = 1 WHERE id = ?').run(info.id);
    this.writeHistory(info.id, history, ext.agent);
    return this.get(info.id)!;
  }

  /** Replaces the event log with a fresh copy of the agent's own history. */
  resync(id: string, history: AgentEvent[]) {
    const info = this.get(id);
    if (!info) throw new Error('会话不存在');
    if (this.runners.get(id)?.busy) throw new Error('会话正在运行，请等它结束后再同步');
    // The running agent process may hold stale context; the next message starts a fresh resume.
    this.dropRunner(id);
    db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
    this.writeHistory(id, history, info.agent);
    this.broadcast(id, { t: 'reset', sessionId: id });
  }

  private writeHistory(id: string, history: AgentEvent[], agent: AgentKind) {
    const label = agent === 'claude' ? 'Claude Code' : 'Codex';
    const all: AgentEvent[] = [
      ...history,
      { type: 'notice', level: 'info', text: `以上是从本机 ${label} 读取的历史记录，可以直接继续对话` },
    ];
    const ts = Date.now();
    const insert = db.prepare('INSERT INTO events (session_id, seq, payload) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    try {
      all.forEach((event, i) => insert.run(id, i + 1, JSON.stringify({ ts, event })));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  getMark(id: string): number | null {
    const r = db.prepare('SELECT external_mark AS m FROM chat_sessions WHERE id = ?').get(id) as { m: number | null } | undefined;
    return r?.m ?? null;
  }

  setMark(id: string, mark: number) {
    db.prepare('UPDATE chat_sessions SET external_mark = ? WHERE id = ?').run(mark, id);
  }

  /** Mark refreshes still in flight after our own turns, so sync checks can wait for them. */
  private pendingMarks = new Map<string, Promise<void>>();

  /** Records how much of the agent's history we have seen, after our own turns finish. */
  private refreshMark(id: string) {
    // The CLI writes its record a moment after the turn ends, hence the delay.
    const p = new Promise<void>((resolve) => setTimeout(resolve, 2000))
      .then(async () => {
        const info = this.get(id);
        if (!info?.agentSessionId || this.isBusy(id)) return;
        void this.syncTitle(id);
        this.setMark(id, await externalMark(info.agent, info.agentSessionId, info.cwd));
      })
      .catch(() => {})
      .finally(() => {
        if (this.pendingMarks.get(id) === p) this.pendingMarks.delete(id);
      });
    this.pendingMarks.set(id, p);
  }

  /**
   * Resolves once the mark reflects our own latest turn. Without this a sync check made
   * right as a turn ends counts that turn as "continued elsewhere".
   */
  async markSettled(id: string) {
    await this.pendingMarks.get(id);
  }

  isBusy(id: string): boolean {
    return this.runners.get(id)?.busy ?? false;
  }

  update(id: string, patch: { title?: string; options?: SessionOptions }): SessionInfo | null {
    const cur = this.get(id);
    if (!cur) return null;
    const title = patch.title ?? cur.title;
    const options = { ...cur.options, ...patch.options };
    // A title chosen by the user is kept from now on.
    db.prepare(
      'UPDATE chat_sessions SET title = ?, options = ?, updated_at = ?, title_auto = CASE WHEN ? THEN 0 ELSE title_auto END WHERE id = ?',
    ).run(title, JSON.stringify(options), Date.now(), patch.title ? 1 : 0, id);
    // Options such as model or sandbox apply when the agent process next starts.
    if (patch.options && !this.runners.get(id)?.busy) this.dropRunner(id);
    this.announce(id);
    return this.get(id)!;
  }

  /** Adds an informational line to the session's timeline. */
  note(id: string, text: string) {
    this.append(id, { type: 'notice', level: 'info', text });
  }

  onIdle(fn: (info: SessionInfo) => void): () => void {
    this.idleListeners.add(fn);
    return () => this.idleListeners.delete(fn);
  }

  getLoop(id: string): LoopState {
    const r = db.prepare('SELECT loop FROM chat_sessions WHERE id = ?').get(id) as { loop: string | null } | undefined;
    return r?.loop ? (JSON.parse(r.loop) as LoopState) : {};
  }

  /** Merges `patch` into the loop state; an undefined value removes the key. */
  setLoop(id: string, patch: LoopState) {
    const next = { ...this.getLoop(id), ...patch };
    for (const k of Object.keys(next) as (keyof LoopState)[]) if (next[k] === undefined) delete next[k];
    db.prepare('UPDATE chat_sessions SET loop = ? WHERE id = ?').run(Object.keys(next).length ? JSON.stringify(next) : null, id);
  }

  /** The latest turn: the user message that started it (if any) and every event after it. */
  lastTurn(id: string): { user?: string; events: StoredEvent[] } {
    const u = db
      .prepare(
        `SELECT seq, payload FROM events WHERE session_id = ? AND json_extract(payload, '$.event.type') = 'user_message' ORDER BY seq DESC LIMIT 1`,
      )
      .get(id) as { seq: number; payload: string } | undefined;
    const user = u ? (JSON.parse(u.payload) as { event: { text: string } }).event.text : undefined;
    return { user, events: this.events(id, u?.seq ?? 0) };
  }

  /** Whether the session's timeline has a notice starting with `prefix`. */
  hasNotice(id: string, prefix: string): boolean {
    return !!db
      .prepare(
        `SELECT 1 FROM events WHERE session_id = ? AND json_extract(payload, '$.event.type') = 'notice' AND json_extract(payload, '$.event.text') LIKE ? LIMIT 1`,
      )
      .get(id, `${prefix}%`);
  }

  /** Persists and broadcasts an event produced outside the agent (e.g. a brief handed off). */
  emit(id: string, event: AgentEvent) {
    this.append(id, event);
  }

  /** Advisor: a card for every brief written or changed during the turn (re-emitted with its hand-off state). */
  private scanBriefs(info: SessionInfo) {
    const since = (this.runningSince.get(info.id) ?? 0) - 2000;
    for (const b of listBriefs(advisorDir(info.project, info.userId))) {
      if (b.updatedAt < since) continue;
      this.append(info.id, { type: 'brief', file: b.file, title: b.title, status: b.status, sessionId: b.sessionId, branch: b.branch });
    }
  }

  worktreeOf(id: string): WorktreeMeta | null {
    const r = db.prepare('SELECT worktree FROM chat_sessions WHERE id = ?').get(id) as { worktree: string | null } | undefined;
    return r?.worktree ? (JSON.parse(r.worktree) as WorktreeMeta) : null;
  }

  /** Stops the session's agent process (e.g. before its worktree is removed) and tells clients. */
  release(id: string) {
    this.dropRunner(id);
    this.announce(id);
  }

  delete(id: string) {
    const owner = this.ownerOf(id);
    this.dropRunner(id);
    deleteUploads(id);
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
    this.subscribers.delete(id);
    if (owner !== undefined) this.broadcastGlobal(owner, { t: 'session.deleted', sessionId: id });
  }

  events(id: string, afterSeq: number): StoredEvent[] {
    const rows = db
      .prepare('SELECT seq, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(id, afterSeq) as { seq: number; payload: string }[];
    return rows.map((r) => ({ seq: r.seq, ...JSON.parse(r.payload) }));
  }

  /**
   * One page of history ending just before `beforeSeq` (or the newest page when null),
   * so long sessions open fast and older pages load as the user scrolls up.
   * The page starts at a user message when one is near, so a turn is not cut in half.
   * The newest page also carries the latest todo / model / context events from before it,
   * since the header and composer show those.
   * `upto`: nothing after this seq (a share link that shows the conversation as it was when shared).
   */
  page(id: string, beforeSeq: number | null, limit = PAGE_SIZE, upto?: number): EventPage {
    let top =
      beforeSeq ??
      ((db.prepare('SELECT MAX(seq) AS m FROM events WHERE session_id = ?').get(id) as { m: number | null }).m ?? 0) + 1;
    if (upto !== undefined) top = Math.min(top, upto + 1);
    let first = top - limit;
    if (first > 1) {
      const u = db
        .prepare(
          `SELECT MAX(seq) AS s FROM events WHERE session_id = ? AND seq <= ? AND seq > ?
             AND json_extract(payload, '$.event.type') = 'user_message'`,
        )
        .get(id, first, first - limit) as { s: number | null };
      if (u.s) first = u.s;
    }
    first = Math.max(first, 1);
    const rows = db
      .prepare('SELECT seq, payload FROM events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq')
      .all(id, first, top) as { seq: number; payload: string }[];
    const hasMore = !!db.prepare('SELECT 1 FROM events WHERE session_id = ? AND seq < ? LIMIT 1').get(id, first);
    const events: StoredEvent[] = rows.map((r) => ({ seq: r.seq, ...JSON.parse(r.payload) }));
    if (beforeSeq === null && hasMore) {
      const latest = db.prepare(
        `SELECT seq, payload FROM events WHERE session_id = ? AND seq < ?
           AND json_extract(payload, '$.event.type') = ? ORDER BY seq DESC LIMIT 1`,
      );
      const state = (['todo', 'session_info', 'context'] as const)
        .map((type) => latest.get(id, first, type) as { seq: number; payload: string } | undefined)
        .filter((r) => r !== undefined)
        .map((r): StoredEvent => ({ seq: r.seq, ...JSON.parse(r.payload) }))
        .sort((a, b) => a.seq - b.seq);
      events.unshift(...state);
    }
    return { events, firstSeq: first, hasMore };
  }

  // ---- subscriptions ----

  subscribe(id: string, fn: Listener) {
    let set = this.subscribers.get(id);
    if (!set) this.subscribers.set(id, (set = new Set()));
    set.add(fn);
  }

  unsubscribe(id: string, fn: Listener) {
    this.subscribers.get(id)?.delete(fn);
  }

  /** Receives changes to the account's session list; an admin's also gets every other account's, as `others`. */
  onGlobal(userId: number, fn: Listener): () => void {
    this.globalListeners.set(fn, userId);
    return () => this.globalListeners.delete(fn);
  }

  private broadcast(id: string, msg: ServerMessage) {
    for (const fn of this.subscribers.get(id) ?? []) fn(msg);
  }

  private broadcastGlobal(userId: number, msg: ServerMessage) {
    let watched: ServerMessage | null | undefined;
    for (const [fn, listener] of this.globalListeners) {
      if (listener === userId) fn(msg);
      // Admins watch every account's sessions (read-only): what is running, before a restart for one.
      else if (account(listener)?.isAdmin) {
        if (watched === undefined) watched = forWatchers(userId, msg);
        if (watched) fn(watched);
      }
    }
  }

  /** Tells the owner's clients the session's current state. */
  private announce(id: string) {
    const info = this.get(id);
    if (info) this.broadcastGlobal(info.userId, { t: 'session', session: info });
  }

  // ---- agent control ----

  async send(id: string, text: string, attachmentIds: string[] = []) {
    const info = this.get(id);
    if (!info) throw new Error('会话不存在');
    if (info.worktree && !info.worktree.exists) throw new Error('这个会话的 worktree 已经删除，只能查看历史');
    // Imported sessions may live anywhere, and members' sessions only in their own folder.
    try {
      await safeDir(info.cwd, rootsOfId(info.userId));
    } catch {
      const owner = account(info.userId);
      const home = owner && homeOf(owner);
      throw new Error(
        home
          ? `该会话的目录 ${info.cwd} 不是你的账号文件夹，只能查看历史`
          : `该会话的目录 ${info.cwd} 不在允许的工作区内。如需继续，请把它（或上级目录）加入 .env 的 WORKSPACE_ROOTS 并重启服务`,
      );
    }
    this.accountSpec(info); // a member without a computer cannot work: fail before the message is recorded
    const files = loadAttachments(id, attachmentIds.slice(0, 20));
    if (!text.trim() && !files.length) return;
    this.append(id, {
      type: 'user_message',
      text,
      attachments: files.length ? files.map(({ path: _p, ...a }) => a) : undefined,
    });
    // First message of a session still named after its folder: name it after the message.
    if (info.title === folderName({ cwd: info.cwd, remote_cwd: info.remoteCwd })) this.setAutoTitle(id, this.titleFromMessage(text, files));
    this.setStatus(id, 'running');
    this.runner(info).send(text, files);
  }

  async compact(id: string) {
    const info = this.get(id);
    if (!info) throw new Error('会话不存在');
    if (!info.inWorkspace) throw new Error('该会话不在工作区内，只能查看');
    const runner = this.runner(info);
    if (!runner.compact) throw new Error('该会话不支持压缩');
    if (runner.busy) throw new Error('会话正在运行，请等它结束后再压缩');
    this.append(id, { type: 'notice', level: 'info', text: '正在压缩上下文…' });
    this.setStatus(id, 'running');
    await runner.compact();
  }

  async interrupt(id: string) {
    await this.runners.get(id)?.interrupt();
  }

  answerPermission(id: string, answer: PermissionAnswer): boolean {
    return this.runners.get(id)?.answerPermission(answer) ?? false;
  }

  async setPermissionMode(id: string, mode: ClaudePermissionMode) {
    const info = this.get(id);
    if (!info || info.agent !== 'claude') return;
    // Written directly rather than via update(), which would restart the agent process.
    db.prepare('UPDATE chat_sessions SET options = ? WHERE id = ?').run(
      JSON.stringify({ ...info.options, permissionMode: mode }),
      id,
    );
    await this.runners.get(id)?.setPermissionMode?.(mode);
    this.announce(id);
    this.append(id, { type: 'notice', level: 'info', text: `权限模式已切换为 ${mode}` });
  }

  async setModel(id: string, model: string | null) {
    const info = this.get(id);
    if (!info) return;
    const options = { ...info.options };
    if (model) options.model = model;
    else delete options.model;
    db.prepare('UPDATE chat_sessions SET options = ? WHERE id = ?').run(JSON.stringify(options), id);
    await this.runners.get(id)?.setModel?.(model);
    this.announce(id);
  }

  async setApprovalPolicy(id: string, policy: CodexApprovalPolicy) {
    const info = this.get(id);
    if (!info || info.agent !== 'codex') return;
    db.prepare('UPDATE chat_sessions SET options = ? WHERE id = ?').run(
      JSON.stringify({ ...info.options, approvalPolicy: policy }),
      id,
    );
    await this.runners.get(id)?.setApprovalPolicy?.(policy);
    this.announce(id);
  }

  /**
   * Idle sessions restart their Codex process so the thread resumes with the new sandbox
   * (and the sandbox settings in ~/.codex/config.toml); a running one switches from its next turn.
   */
  setSandboxMode(id: string, mode: CodexSandboxMode) {
    const info = this.get(id);
    if (!info || info.agent !== 'codex' || info.options.sandboxMode === mode) return;
    // Members' sessions stay read-only here: their work happens on their own computer.
    if (account(info.userId)?.isAdmin === false) return;
    db.prepare('UPDATE chat_sessions SET options = ? WHERE id = ?').run(
      JSON.stringify({ ...info.options, sandboxMode: mode }),
      id,
    );
    const runner = this.runners.get(id);
    if (runner?.busy) runner.setSandboxMode?.(mode);
    else this.dropRunner(id);
    this.announce(id);
  }

  async setEffort(id: string, effort: EffortLevel | null) {
    const info = this.get(id);
    if (!info) return;
    const options = { ...info.options };
    if (effort) options.effort = effort;
    else delete options.effort;
    // Written directly rather than via update(), which would restart the agent process.
    db.prepare('UPDATE chat_sessions SET options = ? WHERE id = ?').run(JSON.stringify(options), id);
    await this.runners.get(id)?.setEffort?.(effort);
    this.announce(id);
  }

  /**
   * A member's working environment: its computer and memory (undefined for admins, who work on
   * this machine). Throws when the member has no computer set yet.
   */
  private accountSpec(info: SessionInfo): AccountSpec | undefined {
    const owner = account(info.userId);
    if (!owner || owner.isAdmin) return undefined;
    if (!owner.remote) throw new Error('管理员还没有给这个账号设置电脑（SSH 地址），暂时不能工作');
    const home = realpathSync(ensureHome(owner)!);
    return { username: owner.username, home, memoryFile: join(home, MEMORY_FILE), remote: owner.remote, projectDir: info.remoteCwd };
  }

  private runner(info: SessionInfo): AgentRunner {
    const existing = this.runners.get(info.id);
    if (existing) return existing;
    // Members: their computer and memory, and nothing of this machine.
    const accountSpec = this.accountSpec(info);
    const host: AgentHost = {
      ...(accountSpec && { account: accountSpec }),
      cwd: info.cwd,
      uploadsDir: uploadDir(info.id),
      options: info.options,
      resumeId: info.agentSessionId,
      ...(info.role === 'advisor' && { advisor: { project: info.project, memoryDir: advisorDir(info.project, info.userId) } }),
      emit: (event) => this.append(info.id, event),
      delta: (delta: LiveDelta) => this.broadcast(info.id, { t: 'delta', sessionId: info.id, delta }),
      idle: () => this.setStatus(info.id, 'idle'),
      waiting: (on) => this.setStatus(info.id, on ? 'waiting' : 'running'),
    };
    const r = info.agent === 'claude' ? new ClaudeRunner(host) : new CodexRunner(host);
    this.runners.set(info.id, r);
    return r;
  }

  private dropRunner(id: string) {
    this.runners.get(id)?.close();
    this.runners.delete(id);
  }

  private append(id: string, event: AgentEvent) {
    const ts = Date.now();
    const { next } = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?')
      .get(id) as { next: number };
    db.prepare('INSERT INTO events (session_id, seq, payload) VALUES (?, ?, ?)').run(
      id,
      next,
      JSON.stringify({ ts, event }),
    );
    if (event.type === 'session_info') {
      db.prepare('UPDATE chat_sessions SET agent_session_id = ? WHERE id = ?').run(event.agentSessionId, id);
    }
    db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(ts, id);
    this.broadcast(id, { t: 'events', sessionId: id, events: [{ seq: next, ts, event }] });
  }

  private setStatus(id: string, status: SessionStatus) {
    const prev = (db.prepare('SELECT status FROM chat_sessions WHERE id = ?').get(id) as { status: SessionStatus } | undefined)?.status;
    const r = db.prepare('UPDATE chat_sessions SET status = ? WHERE id = ? AND status != ?').run(status, id, status);
    if (r.changes && status === 'idle') this.refreshMark(id);
    if (r.changes) {
      if (prev === 'idle') this.runningSince.set(id, Date.now());
      const info = this.get(id);
      if (info) {
        if (status === 'idle' && info.role === 'advisor') this.scanBriefs(info);
        this.broadcastGlobal(info.userId, { t: 'session', session: info });
        if (prev) this.notify(info, prev, status);
        if (status === 'idle' && prev && prev !== 'idle') for (const fn of this.idleListeners) fn(info);
      }
    }
  }

  /** Web Push to the owner's devices for the moments they wait for: a decision is needed, or the task ended. */
  private notify(info: SessionInfo, prev: SessionStatus, next: SessionStatus) {
    const recent = (
      db.prepare('SELECT payload FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 50').all(info.id) as { payload: string }[]
    ).map((r) => (JSON.parse(r.payload) as { event: AgentEvent }).event);
    // Only this turn counts: stop at the message that started it.
    const turn = recent.slice(0, recent.findIndex((e) => e.type === 'user_message') + 1 || recent.length);
    const find = <T extends AgentEvent['type']>(type: T) =>
      turn.find((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
    const clip = (t: string, n = 140) => {
      const one = t.replace(/\s+/g, ' ').trim();
      return one.length > n ? `${one.slice(0, n)}…` : one;
    };

    let body: string;
    let urgency: 'high' | 'normal' = 'normal';
    if (next === 'waiting') {
      const req = find('permission_request');
      if (!req) return;
      urgency = 'high';
      const input = (req.input ?? {}) as { command?: unknown; file_path?: unknown; path?: unknown; changes?: { path: string }[] };
      const target =
        typeof input.command === 'string'
          ? input.command
          : typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.path === 'string'
              ? input.path
              : Array.isArray(input.changes)
                ? input.changes.map((c) => c.path).join(', ')
                : '';
      body = req.questions?.length
        ? `有问题需要你回答：${clip(req.questions[0].question)}`
        : req.toolName === 'ExitPlanMode'
          ? '计划已写好，等你审批'
          : `${
              /^mcp(__|:)remote(__|\/)run$/.test(req.toolName)
                ? '请求在他的电脑上执行命令'
                : /^mcp(__|:)remote(__|\/)(write|edit)_file$/.test(req.toolName)
                  ? '请求修改他电脑上的文件'
                  : req.toolName === 'Bash'
                    ? '请求执行命令'
                    : /Edit|Write|Patch/.test(req.toolName)
                      ? '请求修改文件'
                      : `请求使用 ${req.toolName}`
            }${target ? `：${clip(target)}` : ''}`;
    } else if (next === 'idle' && prev !== 'idle') {
      const end = find('turn_end');
      if (end?.error === '已中断') return; // the user stopped it themselves
      if (end && !end.ok) body = `失败：${clip(end.error ?? '未知错误')}`;
      else {
        const reply = find('assistant_text');
        body = reply ? `✓ ${clip(reply.text)}` : '✓ 任务已完成';
      }
    } else return;

    pushUser(
      info.userId,
      { title: `${info.title} · ${info.agent === 'claude' ? 'Claude' : 'Codex'}`, body, tag: info.id, url: `/#/s/${info.id}` },
      urgency,
    );
  }

  shutdown() {
    for (const id of [...this.runners.keys()]) this.dropRunner(id);
  }
}

export const sessions = new SessionManager();
