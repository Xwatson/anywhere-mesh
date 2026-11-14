// Account management for admins. There is no sign-up: every account is added here (or with the CLI).
// A member works only on its own computer, over SSH: the admin sets that computer here.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ensureHome, folderExists, forgetAccount, homePathOf, setRemote } from '../accounts.js';
import { deleteAccountAdvisors } from '../advisors.js';
import {
  adminCount,
  createUser,
  deleteUser,
  getUser,
  passwordProblem,
  requireAdmin,
  requireAuth,
  setAdmin,
  setPassword,
  usernameProblem,
} from '../auth.js';
import { db } from '../db.js';
import { dropDevices } from '../push.js';
import { testRemote, validHost, validPort, type RemoteTarget } from '../remote/ssh.js';
import { sessions } from '../sessions.js';
import type { AccountInfo, OtherSession } from '../shared/protocol.js';
import { terminals } from '../terminals.js';
import { dropStaleSockets, reconnectSockets } from './ws.js';

/** Every account with what the admin needs to know about it, oldest first. */
function accounts(): AccountInfo[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.is_admin, u.created_at, u.last_login_at, u.remote_host, u.remote_port,
         (SELECT COUNT(*) FROM chat_sessions c WHERE c.user_id = u.id) AS sessions,
         (SELECT COUNT(*) FROM chat_sessions c WHERE c.user_id = u.id AND c.status != 'idle') AS busy,
         (SELECT COUNT(*) FROM push_subscriptions p WHERE p.user_id = u.id) AS devices
       FROM users u ORDER BY u.id`,
    )
    .all() as {
    id: number;
    username: string;
    is_admin: number;
    created_at: number;
    last_login_at: number | null;
    remote_host: string | null;
    remote_port: number | null;
    sessions: number;
    busy: number;
    devices: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    isAdmin: !!r.is_admin,
    home: r.is_admin ? null : homePathOf(r.username),
    remote: r.remote_host ? { host: r.remote_host, port: r.remote_port } : null,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    sessions: r.sessions,
    busySessions: r.busy,
    pushDevices: r.devices,
  }));
}

/** The computer in a request: undefined = leave as is, null = none. */
function parseRemote(host: unknown, port: unknown): RemoteTarget | null | undefined {
  if (host === undefined) return undefined;
  if (host === null || (typeof host === 'string' && !host.trim())) return null;
  const h = String(host).trim();
  const p = port === null || port === undefined || port === '' ? null : Number(port);
  if (!validHost(h)) throw new Error('电脑的地址要写成 用户名@IP（或主机名），也可以是 ~/.ssh/config 里的 Host 别名');
  if (!validPort(p)) throw new Error('端口要是 1–65535 之间的数字，默认 22 可以不填');
  return { host: h, port: p };
}

const folderTaken = (reply: FastifyReply, username: string) => {
  const path = homePathOf(username);
  return reply.code(409).send({ error: `工作区里已经有 ${path}，这个账号会用它存放记忆，并能在网页上查看和修改里面的 AGENTS.md`, code: 'folder_exists', path });
};

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireAdmin);

  app.get('/api/admin/users', async () => accounts());

  /** Every other account's sessions, newest first: admins watch them (read-only), e.g. before a restart. */
  app.get('/api/admin/sessions', async (req): Promise<OtherSession[]> => {
    const users = new Map(
      (db.prepare('SELECT id, username, is_admin FROM users').all() as { id: number; username: string; is_admin: number }[]).map((u) => [u.id, u]),
    );
    return sessions.list().flatMap((s) => {
      const u = users.get(s.userId);
      return u && u.id !== req.user!.id ? [{ ...s, owner: u.username, member: !u.is_admin }] : [];
    });
  });

  app.post<{ Body: { username?: unknown; password?: unknown; isAdmin?: unknown; adoptFolder?: unknown; remoteHost?: unknown; remotePort?: unknown } }>(
    '/api/admin/users',
    async (req, reply) => {
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      const isAdmin = req.body?.isAdmin === true;
      const problem = usernameProblem(username) ?? passwordProblem(password);
      if (problem) return reply.code(400).send({ error: problem });
      let remote: RemoteTarget | null | undefined;
      try {
        remote = parseRemote(req.body?.remoteHost, req.body?.remotePort);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      // A member's memory lives in <workspace>/<username>: an existing folder of that name would become theirs.
      if (!isAdmin && folderExists(username) && req.body?.adoptFolder !== true) return folderTaken(reply, username);
      const user = createUser(username, password, isAdmin);
      if (remote) setRemote(user.id, remote);
      ensureHome({ ...user, remote });
      req.log.warn({ by: req.user!.username, user: user.username, admin: user.isAdmin, remote: remote?.host }, 'account created');
      return accounts();
    },
  );

  app.patch<{ Params: { id: string }; Body: { password?: unknown; isAdmin?: unknown; adoptFolder?: unknown; remoteHost?: unknown; remotePort?: unknown } }>(
    '/api/admin/users/:id',
    async (req, reply) => {
      const target = getUser(Number(req.params.id));
      if (!target) return reply.code(404).send({ error: '账号不存在' });
      const self = target.id === req.user!.id;
      const { password, isAdmin } = req.body ?? {};
      let remote: RemoteTarget | null | undefined;
      try {
        remote = parseRemote(req.body?.remoteHost, req.body?.remotePort);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      if (password !== undefined) {
        if (self) return reply.code(400).send({ error: '自己的密码请在「修改密码」里改' });
        const problem = passwordProblem(String(password));
        if (problem) return reply.code(400).send({ error: problem });
        // A reset signs the account out everywhere: its logins, open pages and push devices.
        setPassword(target.id, String(password));
        dropDevices(target.id);
        dropStaleSockets(target.id);
        req.log.warn({ by: req.user!.username, user: target.username }, 'password reset');
      }
      // Agents keep the computer, folders and setup they started with: stop them, the next message starts them anew.
      const restart = () => {
        forgetAccount(target.id);
        for (const s of sessions.list(target.id)) sessions.release(s.id);
      };
      if (typeof isAdmin === 'boolean' && isAdmin !== target.isAdmin) {
        if (!isAdmin && self) return reply.code(400).send({ error: '不能取消自己的管理员身份' });
        if (!isAdmin && adminCount() <= 1) return reply.code(400).send({ error: '至少要保留一个管理员' });
        if (!isAdmin && folderExists(target.username) && req.body?.adoptFolder !== true) return folderTaken(reply, target.username);
        setAdmin(target.id, isAdmin);
        restart();
        if (!isAdmin) {
          terminals.killAll(target.id);
          ensureHome({ ...target, isAdmin });
          // Its open pages may be watching other accounts' sessions.
          reconnectSockets(target.id);
        }
        req.log.warn({ by: req.user!.username, user: target.username, admin: isAdmin }, 'admin changed');
      }
      if (remote !== undefined) {
        setRemote(target.id, remote);
        restart();
        req.log.warn({ by: req.user!.username, user: target.username, remote: remote?.host ?? null }, 'computer changed');
      }
      return accounts();
    },
  );

  /** Whether a computer answers over SSH (before or after saving it for an account). */
  app.post<{ Body: { host?: unknown; port?: unknown } }>('/api/admin/remote-test', async (req, reply) => {
    let remote: RemoteTarget | null | undefined;
    try {
      remote = parseRemote(req.body?.host ?? null, req.body?.port);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if (!remote) return reply.code(400).send({ error: '先填电脑的地址' });
    return testRemote(remote);
  });

  /**
   * Deletes the account with its sessions (history, uploads), terminals, advisor memories,
   * logins and push devices. A member's folder (its memory) and worktree folders and branches
   * stay on disk.
   */
  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    const target = getUser(Number(req.params.id));
    if (!target) return reply.code(404).send({ error: '账号不存在' });
    if (target.id === req.user!.id) return reply.code(400).send({ error: '不能删除自己的账号' });
    if (target.isAdmin && adminCount() <= 1) return reply.code(400).send({ error: '至少要保留一个管理员' });
    for (const s of sessions.list(target.id)) sessions.delete(s.id);
    terminals.killAll(target.id);
    deleteAccountAdvisors(target.id);
    deleteUser(target.id);
    forgetAccount(target.id);
    dropStaleSockets(target.id);
    req.log.warn({ by: req.user!.username, user: target.username }, 'account deleted');
    return accounts();
  });
}
