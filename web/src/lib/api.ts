import type {
  AccountInfo,
  AccountMemory,
  AdvisorMemory,
  AdvisorSettings,
  AgentKind,
  BriefInfo,
  Attachment,
  AgentModels,
  EventPage,
  ExternalSession,
  OtherSession,
  GitInfo,
  Progress,
  RemoteListing,
  SessionInfo,
  SessionOptions,
  SessionRole,
  SessionStatus,
  SharedSession,
  ShareInfo,
  StoredEvent,
  TerminalInfo,
  SystemInfo,
  UsageInfo,
  WorktreeStatus,
} from '../../../server/src/shared/protocol';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Machine-readable reason some endpoints add, e.g. 'identity' for git commits. */
    public code?: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized();
    throw new ApiError(res.status, data.error || `请求失败 (${res.status})`, data.code);
  }
  return data as T;
}

export interface User {
  id: number;
  username: string;
  /** Admins manage accounts, see the machine's CLI history and restart the service. */
  isAdmin: boolean;
}

export interface DirListing {
  path: string;
  isGit: boolean;
  dirs: { name: string; path: string }[];
}

export interface DiffResult {
  isGit: boolean;
  branch: string;
  status: string;
  diff: string;
}

export interface Meta {
  /** Where the account may work: a member's own folder, or the whole workspace for admins. */
  roots: string[];
  /** `roots` with symlinks resolved, index-aligned with `roots`; `project` paths are resolved, so compare against these too. */
  rootsReal: string[];
  versions: { claude: string | null; codex: string | null };
  /** A member's folder here (its memory); null for admins. */
  home?: string | null;
  /** A member's own computer, where its sessions work (null: not set yet; always null for admins). */
  remote?: { host: string; port: number | null } | null;
}

/** Uploads one file as the raw request body, reporting progress (0–1). */
export function uploadFile(sessionId: string, file: File, onProgress: (p: number) => void): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/sessions/${sessionId}/uploads?name=${encodeURIComponent(file.name || 'pasted.png')}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: string } & Partial<Attachment> = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status === 401) onUnauthorized();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Attachment);
      else reject(new Error(data.error || (xhr.status === 413 ? '文件太大（上限 20MB）' : `上传失败 (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error('上传失败：网络错误'));
    xhr.send(file);
  });
}

export const uploadUrl = (sessionId: string, id: string) =>
  `/api/sessions/${sessionId}/uploads/${encodeURIComponent(id)}`;

export const sharedUploadUrl = (token: string, id: string) => `/api/share/${token}/uploads/${encodeURIComponent(id)}`;

/** The address people open to see a shared session. */
export const shareLink = (token: string) => `${location.origin}/share/${token}`;

/**
 * A server from before accounts (still running right after a rebuild, until it is restarted)
 * does not send isAdmin: its one user could do everything, so keep the restart button visible.
 */
const withRole = (r: { user: User }) => ({ user: { ...r.user, isAdmin: r.user.isAdmin ?? true } });

export const api = {
  login: (username: string, password: string) => req<{ user: User }>('POST', '/api/auth/login', { username, password }).then(withRole),
  logout: () => req('POST', '/api/auth/logout'),
  me: () => req<{ user: User }>('GET', '/api/auth/me').then(withRole),
  /** `endpoint`: this device's push subscription, kept while the account's other devices are signed out. */
  changePassword: (current: string, password: string, endpoint?: string) =>
    req<{ ok: true }>('POST', '/api/auth/password', { current, password, endpoint }),

  // ---- accounts (admins only); every change answers with the updated list ----
  accounts: () => req<AccountInfo[]>('GET', '/api/admin/users'),
  /** Fails with code 'folder_exists' when a member's folder is already there, unless `adoptFolder`. */
  addAccount: (body: { username: string; password: string; isAdmin: boolean; remoteHost?: string; remotePort?: number | null; adoptFolder?: boolean }) =>
    req<AccountInfo[]>('POST', '/api/admin/users', body),
  /** remoteHost null clears the member's computer. */
  updateAccount: (id: number, patch: { password?: string; isAdmin?: boolean; adoptFolder?: boolean; remoteHost?: string | null; remotePort?: number | null }) =>
    req<AccountInfo[]>('PATCH', `/api/admin/users/${id}`, patch),
  deleteAccount: (id: number) => req<AccountInfo[]>('DELETE', `/api/admin/users/${id}`),
  testRemote: (host: string, port: number | null) => req<{ ok: boolean; output: string }>('POST', '/api/admin/remote-test', { host, port }),

  meta: () => req<Meta>('GET', '/api/meta'),
  dirs: (path?: string) => req<DirListing>('GET', `/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  mkdir: (parent: string, name: string) => req<{ path: string }>('POST', '/api/fs/mkdir', { parent, name }),
  /** Members: folders on their own computer (default: its home folder). */
  remoteDirs: (path?: string) => req<RemoteListing>('GET', `/api/remote/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  remoteMkdir: (parent: string, name: string) => req<{ path: string }>('POST', '/api/remote/mkdir', { parent, name }),
  memory: () => req<AccountMemory>('GET', '/api/memory'),
  /** `updatedAt`: the version being replaced; refused (409) when the AI changed it since. */
  saveMemory: (content: string, updatedAt: number) => req<{ ok: true; updatedAt: number }>('PUT', '/api/memory', { content, updatedAt }),

  sessions: () => req<SessionInfo[]>('GET', '/api/sessions'),
  createSession: (body: {
    agent: AgentKind;
    cwd: string;
    title?: string;
    options: SessionOptions;
    /** Work in a new git worktree on its own branch (auto-named when empty). */
    worktree?: { branch?: string; base?: string };
    /** Members: the project folder on their own computer. */
    remoteCwd?: string;
    /** 'advisor': the project's product advisor; the existing one is returned unless `fresh`. */
    role?: SessionRole;
    fresh?: boolean;
  }) => req<SessionInfo>('POST', '/api/sessions', body),
  advisorMemory: (id: string) => req<AdvisorMemory>('GET', `/api/sessions/${id}/memory`),
  briefs: (id: string) => req<BriefInfo[]>('GET', `/api/sessions/${id}/briefs`),
  progress: (id: string) => req<Progress>('GET', `/api/sessions/${id}/progress`),
  /** Ends a brief's coding session that has nothing to merge. */
  finish: (id: string) => req<{ ok: true }>('POST', `/api/sessions/${id}/finish`),
  advisorSettings: (id: string) => req<AdvisorSettings>('GET', `/api/sessions/${id}/advisor-settings`),
  updateAdvisorSettings: (id: string, patch: Partial<AdvisorSettings>) => req<AdvisorSettings>('PATCH', `/api/sessions/${id}/advisor-settings`, patch),
  /** Hands a brief of advisor session `id` to a new coding session; returns that session. */
  /** Sends text (a coding session's summary) to the project's advisor as a message. */
  report: (id: string, text: string) => req<{ ok: true; advisorId: string }>('POST', `/api/sessions/${id}/report`, { text }),
  handoff: (id: string, file: string, options?: SessionOptions) => req<SessionInfo>('POST', `/api/sessions/${id}/handoff`, { file, options }),
  branches: (path: string) => req<{ branches: string[]; current: string | null }>('GET', `/api/fs/branches?path=${encodeURIComponent(path)}`),
  worktree: (id: string) => req<WorktreeStatus>('GET', `/api/sessions/${id}/worktree`),
  worktreeAction: (id: string, action: 'merge' | 'remove', body: { force?: boolean; deleteBranch?: boolean } = {}) =>
    req<{ ok: true; summary?: string }>('POST', `/api/sessions/${id}/worktree/${action}`, body),
  updateSession: (id: string, body: { title?: string; options?: SessionOptions }) =>
    req<SessionInfo>('PATCH', `/api/sessions/${id}`, body),
  /** removeWorktree: also delete the session's worktree directory and branch. */
  deleteSession: (id: string, opts: { removeWorktree?: boolean; force?: boolean } = {}) =>
    req('DELETE', `/api/sessions/${id}${opts.removeWorktree ? `?worktree=remove${opts.force ? '&force=1' : ''}` : ''}`),
  shares: (id: string) => req<ShareInfo[]>('GET', `/api/sessions/${id}/shares`),
  /** `live`: viewers also see what happens after the link was made; `password` empty for none. */
  createShare: (id: string, body: { hours: number; password?: string; live: boolean }) => req<ShareInfo>('POST', `/api/sessions/${id}/shares`, body),
  deleteShare: (id: string, shareId: string) => req<{ ok: true }>('DELETE', `/api/sessions/${id}/shares/${shareId}`),

  // ---- a shared link, as the people who have it see it (no login): 403 with code 'password' until it is given ----
  shared: (token: string) => req<{ session: SharedSession; page: EventPage }>('GET', `/api/share/${token}`),
  sharedOlder: (token: string, before: number) => req<EventPage>('GET', `/api/share/${token}/events?before=${before}`),
  /** `reset`: too far behind, load the newest page again instead. */
  sharedNewer: (token: string, after: number) =>
    req<{ events: StoredEvent[]; status: SessionStatus; reset?: boolean }>('GET', `/api/share/${token}/events?after=${after}`),
  unlockShare: (token: string, password: string) => req<{ ok: true }>('POST', `/api/share/${token}/unlock`, { password }),

  diff: (id: string) => req<DiffResult>('GET', `/api/sessions/${id}/diff`),
  git: (id: string) => req<GitInfo>('GET', `/api/sessions/${id}/git`),
  gitAction: <T = Record<string, unknown>>(id: string, action: 'commit' | 'identity' | 'push' | 'pull' | 'branch' | 'pr', body: object = {}) =>
    req<T & { ok: true }>('POST', `/api/sessions/${id}/git/${action}`, body),
  syncStatus: (id: string) =>
    req<{ behind: boolean; holders?: { pid: number; entrypoint: string }[] }>('GET', `/api/sessions/${id}/sync-status`),
  resync: (id: string) => req('POST', `/api/sessions/${id}/resync`),
  olderEvents: (id: string, before: number) => req<EventPage>('GET', `/api/sessions/${id}/events?before=${before}`),

  models: () => req<AgentModels>('GET', '/api/models'),
  pushInfo: (endpoint?: string) =>
    req<{ publicKey: string; subscribed: boolean }>('GET', `/api/push${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`),
  pushSubscribe: (subscription: PushSubscriptionJSON) => req<{ ok: true }>('POST', '/api/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint: string) => req<{ ok: true }>('POST', '/api/push/unsubscribe', { endpoint }),
  pushTest: (endpoint: string) => req<{ ok: true }>('POST', '/api/push/test', { endpoint }),
  system: () => req<SystemInfo>('GET', '/api/system'),
  restartService: () => req<{ ok: true }>('POST', '/api/system/restart'),
  /** Admins: every other account's sessions (to watch, read-only). */
  otherSessions: () => req<OtherSession[]>('GET', '/api/admin/sessions'),
  usage: (refresh = false) => req<UsageInfo>('GET', `/api/usage${refresh ? '?refresh=1' : ''}`),
  history: (agent?: AgentKind) => req<ExternalSession[]>('GET', `/api/history${agent ? `?agent=${agent}` : ''}`),
  importHistory: (agent: AgentKind, id: string) => req<SessionInfo>('POST', '/api/history/import', { agent, id }),

  terminals: () => req<TerminalInfo[]>('GET', '/api/terminals'),
  createTerminal: (cwd: string, command?: string) => req<TerminalInfo>('POST', '/api/terminals', { cwd, command }),
  killTerminal: (id: string) => req('DELETE', `/api/terminals/${id}`),
};
