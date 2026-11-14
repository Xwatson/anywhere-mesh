import type { FastifyInstance } from 'fastify';
import {
  checkCredentials,
  checkPassword,
  clientIp,
  COOKIE_NAME,
  createAuthSession,
  destroyAuthSession,
  isSecureRequest,
  isThrottled,
  passwordProblem,
  recordFailure,
  requireAdmin,
  requireAuth,
  setPassword,
} from '../auth.js';
import { config } from '../config.js';
import { externalInfo, externalMark, listExternal, loadHistory } from '../external/history.js';
import { claudeHoldersElsewhere } from '../external/holders.js';
import { getModels } from '../external/models.js';
import { getUsage } from '../external/usage.js';
import { advisorDir, ensureAdvisorMemory, listBriefs, readAdvisorMemory, readAdvisorSettings, writeAdvisorSettings } from '../advisors.js';
import { CODING_OPTIONS, handoffBrief } from '../handoff.js';
import { advisorFor, finishReport, fromBrief, maybeAutoHandoff, mergedReport, progress, prReport, report } from '../loop.js';
import { ONBOARDING_PROMPT, RESUME_PROMPT } from '../agents/advisor.js';
import { cliVersions, gitDiff, inWorkspace, listDirs, makeDir, projectOf, realWorkspaceRoots, safeDir, subdirOf } from '../files.js';
import { account, ensureHome, memoryFileOf, mtimeOf, rootsOf } from '../accounts.js';
import { listRemoteDirs, makeRemoteDir, shareConnections } from '../remote/ssh.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, createBranch, createPr, GitError, gitInfo, pull, push, setIdentity, tryGit } from '../git.js';
import { createWorktree, mainRepo, mergeWorktree, removeWorktree, worktreeStatus } from '../worktrees.js';
import { dropDevices, isSubscribed, pushTest, subscribe, unsubscribe, vapidPublicKey } from '../push.js';
import { dropStaleSockets } from './ws.js';
import { sessions } from '../sessions.js';
import { createShare, deleteShare, listShares, SHARE_DEFAULT_HOURS, shareProblem } from '../shares.js';
import { restartService, systemInfo } from '../system.js';
import type { AdvisorSettings, AgentKind, SessionOptions, SessionRole } from '../shared/protocol.js';
import { terminals } from '../terminals.js';
import { MAX_UPLOAD_BYTES, saveUpload, sendUpload, uploadPath } from '../uploads.js';
import { basename } from 'node:path';

const AGENTS: AgentKind[] = ['claude', 'codex'];

// Browsing a member's computer reuses one SSH connection per computer, like the sessions' own tools do.
const SSH_DIR = join(config.dataDir, 'ssh');
mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
shareConnections(SSH_DIR);
const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES = ['on-request', 'untrusted', 'never'];
const EFFORTS: string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** Advisor sessions start with the same presets as the "+" menu's quick Claude sessions. */
const ADVISOR_OPTIONS: SessionOptions = { permissionMode: 'auto', model: 'opus', effort: 'high' };

function cleanOptions(agent: AgentKind, o: Partial<SessionOptions> = {}): SessionOptions {
  const out: SessionOptions = {};
  if (typeof o.model === 'string' && o.model.trim()) out.model = o.model.trim();
  if (o.effort && EFFORTS.includes(o.effort)) out.effort = o.effort;
  if (agent === 'claude') {
    out.permissionMode = PERMISSION_MODES.includes(o.permissionMode as string) ? o.permissionMode : 'default';
  } else {
    out.sandboxMode = SANDBOX_MODES.includes(o.sandboxMode as string) ? o.sandboxMode : 'danger-full-access';
    out.approvalPolicy = APPROVAL_POLICIES.includes(o.approvalPolicy as string) ? o.approvalPolicy : 'on-request';
  }
  return out;
}

export async function apiRoutes(app: FastifyInstance) {
  // ---- auth (public) ----
  app.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const ip = clientIp(req);
    if (isThrottled(ip, username)) return reply.code(429).send({ error: '尝试次数过多，请 15 分钟后再试' });
    const user = checkCredentials(username, password);
    if (!user) {
      recordFailure(ip, username);
      req.log.warn({ ip, username }, 'login failed');
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    const token = createAuthSession(user.id);
    reply.setCookie(COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: isSecureRequest(req),
      maxAge: config.sessionTtlMs / 1000,
    });
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroyAuthSession(req.cookies[COOKIE_NAME]);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  // ---- everything below requires a login ----
  app.register(async (priv) => {
    priv.addHook('preHandler', requireAuth);
    // Sessions and terminals named in the URL must belong to the signed-in account; another
    // account's look as if they did not exist. Admins may read (not change) every account's
    // sessions: the session, its history and its attachments.
    priv.addHook('preHandler', async (req, reply) => {
      const id = (req.params as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string') return;
      const route = req.routeOptions.url ?? '';
      const watch =
        req.user!.isAdmin && (req.method === 'GET' || req.method === 'HEAD') && /^\/api\/sessions\/:id(\/events|\/uploads\/:file)?$/.test(route);
      const owner = route.startsWith('/api/sessions/:id') ? sessions.ownerOf(id) : undefined;
      const mine = route.startsWith('/api/sessions/:id')
        ? owner === req.user!.id || (watch && owner !== undefined)
        : route.startsWith('/api/terminals/:id')
          ? terminals.owns(id, req.user!.id)
          : true;
      if (!mine) return reply.code(404).send({ error: 'not found' });
    });
    // Members work only on their own computer: nothing here reads or changes this machine's folders or repositories for them.
    priv.addHook('preHandler', async (req, reply) => {
      if (req.user!.isAdmin) return;
      const route = req.routeOptions.url ?? '';
      if (route.startsWith('/api/fs/') || /^\/api\/sessions\/:id\/(git|diff|worktree)/.test(route)) {
        return reply.code(403).send({ error: '这个账号的项目在它自己的电脑上，这里没有可以操作的文件夹和仓库' });
      }
    });

    priv.get('/api/auth/me', async (req) => ({ user: req.user }));

    /** Changes the signed-in account's own password; its other logins (and their push) end, this one stays. */
    priv.post<{ Body: { current?: string; password?: string; endpoint?: string } }>('/api/auth/password', async (req, reply) => {
      const user = req.user!;
      const ip = clientIp(req);
      if (isThrottled(ip, user.username)) return reply.code(429).send({ error: '尝试次数过多，请 15 分钟后再试' });
      if (!checkPassword(user.id, String(req.body?.current ?? ''))) {
        recordFailure(ip, user.username);
        return reply.code(400).send({ error: '当前密码不对' });
      }
      const password = String(req.body?.password ?? '');
      const problem = passwordProblem(password);
      if (problem) return reply.code(400).send({ error: problem });
      setPassword(user.id, password, req.cookies[COOKIE_NAME]);
      dropDevices(user.id, typeof req.body?.endpoint === 'string' ? req.body.endpoint : undefined);
      dropStaleSockets(user.id);
      req.log.info({ user: user.username }, 'password changed');
      return { ok: true };
    });

    // ---- Web Push ----
    priv.get<{ Querystring: { endpoint?: string } }>('/api/push', async (req) => ({
      publicKey: vapidPublicKey,
      subscribed: req.query.endpoint ? isSubscribed(req.query.endpoint, req.user!.id) : false,
    }));

    priv.post<{ Body: { subscription?: unknown } }>('/api/push/subscribe', async (req, reply) => {
      if (!subscribe(req.user!.id, req.body?.subscription, req.headers['user-agent'])) {
        return reply.code(400).send({ error: '无效的推送订阅' });
      }
      return { ok: true };
    });

    priv.post<{ Body: { endpoint?: string } }>('/api/push/unsubscribe', async (req) => {
      if (typeof req.body?.endpoint === 'string') unsubscribe(req.body.endpoint);
      return { ok: true };
    });

    priv.post<{ Body: { endpoint?: string } }>('/api/push/test', async (req, reply) => {
      const err = await pushTest(String(req.body?.endpoint ?? ''), req.user!.id);
      return err ? reply.code(502).send({ error: `推送服务返回错误：${err}` }) : { ok: true };
    });

    // ---- the service itself (shared by every account: admins only) ----
    priv.get('/api/system', { preHandler: requireAdmin }, async (req) =>
      systemInfo(
        sessions
          .list()
          .filter((s) => s.status !== 'idle')
          .map((s) => ({ owner: account(s.userId)?.username ?? '?', title: s.title, mine: s.userId === req.user!.id })),
      ),
    );

    priv.post('/api/system/restart', { preHandler: requireAdmin }, async (req, reply) => {
      try {
        restartService();
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      req.log.warn({ user: req.user?.username }, 'service restart requested from the web UI');
      return { ok: true };
    });

    // Admins: the whole workspace. Members: their computer, and their folder here (memory only, created on first use).
    priv.get('/api/meta', async (req) => {
      const me = account(req.user!.id);
      const home = ensureHome({ ...req.user!, remote: me?.remote });
      const roots = rootsOf(req.user!);
      return { roots, rootsReal: realWorkspaceRoots(roots), versions: await cliVersions(), home, remote: home ? (me?.remote ?? null) : null };
    });

    priv.get<{ Querystring: { path?: string } }>('/api/fs/dirs', async (req, reply) => {
      const roots = rootsOf(req.user!);
      try {
        return await listDirs(req.query.path || roots[0], roots);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    /** New folder in the folder picker, anywhere the account may work. */
    priv.post<{ Body: { parent?: unknown; name?: unknown } }>('/api/fs/mkdir', async (req, reply) => {
      try {
        return { path: await makeDir(String(req.body?.parent ?? ''), String(req.body?.name ?? ''), rootsOf(req.user!)) };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    // ---- folders on a member's own computer, for choosing a session's project there ----
    priv.get<{ Querystring: { path?: string } }>('/api/remote/dirs', async (req, reply) => {
      const remote = req.user!.isAdmin ? null : account(req.user!.id)?.remote;
      if (!remote) return reply.code(400).send({ error: req.user!.isAdmin ? '管理员账号在这台服务器上工作' : '管理员还没有给你的账号设置电脑' });
      try {
        return await listRemoteDirs(remote, String(req.query.path ?? ''));
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    priv.post<{ Body: { parent?: unknown; name?: unknown } }>('/api/remote/mkdir', async (req, reply) => {
      const remote = req.user!.isAdmin ? null : account(req.user!.id)?.remote;
      if (!remote) return reply.code(400).send({ error: '这个账号没有设置电脑' });
      try {
        return { path: await makeRemoteDir(remote, String(req.body?.parent ?? ''), String(req.body?.name ?? '')) };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    // ---- a member's memory (AGENTS.md in its folder), loaded by its Claude and Codex sessions ----
    priv.get('/api/memory', async (req) => {
      const path = memoryFileOf(req.user!);
      if (!path) return { available: false };
      ensureHome({ ...req.user!, remote: account(req.user!.id)?.remote });
      return { available: true, path, content: readFileSync(path, 'utf8'), updatedAt: mtimeOf(path) };
    });

    priv.put<{ Body: { content?: unknown; updatedAt?: unknown } }>('/api/memory', async (req, reply) => {
      const path = memoryFileOf(req.user!);
      if (!path) return reply.code(404).send({ error: '管理员账号没有账号记忆，Claude 用的是本机的 ~/.claude/CLAUDE.md' });
      const content = req.body?.content;
      if (typeof content !== 'string') return reply.code(400).send({ error: '内容无效' });
      if (content.length > 200_000) return reply.code(400).send({ error: '记忆太长了（上限 20 万字符），请精简' });
      ensureHome(req.user!);
      // The agents edit it too: refuse to overwrite a version the user has not seen.
      if (typeof req.body?.updatedAt === 'number' && Math.abs(mtimeOf(path) - req.body.updatedAt) > 1) {
        return reply.code(409).send({ error: '记忆在你编辑的时候被 AI 更新过了。请先复制你的修改，重新打开后再改' });
      }
      writeFileSync(path, content);
      return { ok: true, updatedAt: mtimeOf(path) };
    });

    // ---- chat sessions ----
    priv.get('/api/sessions', async (req) => sessions.list(req.user!.id));

    priv.post<{
      Body: {
        agent: AgentKind;
        cwd: string;
        title?: string;
        options?: SessionOptions;
        worktree?: { branch?: string; base?: string };
        /** Members: the project folder on their own computer (default: their home folder there). */
        remoteCwd?: string;
        /** 'advisor': the project's product advisor (Claude only, no worktree, one per project). */
        role?: SessionRole;
        /** With role: start a new conversation although the project already has an advisor (its memory is kept). */
        fresh?: boolean;
      };
    }>('/api/sessions', async (req, reply) => {
      const { agent, title, options, worktree, role, fresh } = req.body ?? ({} as never);
      if (role !== undefined && role !== 'advisor') return reply.code(400).send({ error: '未知的角色' });
      if (role !== 'advisor' && !AGENTS.includes(agent)) return reply.code(400).send({ error: '未知的 agent' });
      // Members: every session works on their computer, started from their folder here (where their memory is).
      if (!req.user!.isAdmin) {
        if (role || worktree) return reply.code(400).send({ error: '管家和 worktree 需要项目在这台服务器上，这个账号用不了' });
        const me = account(req.user!.id);
        if (!me?.remote) return reply.code(400).send({ error: '管理员还没有给你的账号设置电脑（SSH 地址），暂时不能新建会话' });
        const home = ensureHome(me)!;
        // The project must exist on the member's computer; its path is stored as that system writes it.
        let project: string;
        try {
          project = (await listRemoteDirs(me.remote, typeof req.body.remoteCwd === 'string' ? req.body.remoteCwd.trim() : '')).path;
        } catch (e) {
          return reply.code(400).send({ error: (e as Error).message });
        }
        const opts = cleanOptions(agent, { ...options, sandboxMode: 'read-only' });
        return sessions.create(req.user!.id, agent, await safeDir(home, [home]), title, opts, undefined, undefined, undefined, undefined, project);
      }
      const roots = rootsOf(req.user!);
      let cwd: string;
      try {
        cwd = await safeDir(req.body.cwd, roots);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      const userId = req.user!.id;
      if (role === 'advisor') {
        // The advisor works from the repository root; its memory is handed over with the first prompt.
        const root = projectOf(cwd);
        const project = inWorkspace(root, roots) ? root : cwd;
        const existing = sessions.advisorOf(project, userId);
        if (existing && !fresh) return existing;
        ensureAdvisorMemory(advisorDir(project, userId));
        const info = sessions.create(
          userId,
          'claude',
          project,
          `管家 · ${basename(project)}`,
          cleanOptions('claude', { ...ADVISOR_OPTIONS, ...options }),
          undefined,
          undefined,
          'advisor',
        );
        // Takes office right away: a new advisor studies the project, a fresh conversation picks up from memory.
        sessions.send(info.id, existing ? RESUME_PROMPT : ONBOARDING_PROMPT).catch((e: Error) => sessions.note(info.id, `上任消息发送失败：${e.message}`));
        return sessions.get(info.id);
      }
      if (!worktree) return sessions.create(userId, agent, cwd, title, cleanOptions(agent, options));
      try {
        const wt = await createWorktree(cwd, { ...worktree, agent, roots });
        const info = sessions.create(userId, agent, wt.cwd, title, cleanOptions(agent, options), undefined, wt.meta);
        sessions.note(
          info.id,
          `已创建 worktree：分支 ${wt.meta.branch}（基于 ${wt.meta.base}），目录 ${wt.meta.path}` +
            (wt.copied.length ? `；已复制本地文件 ${wt.copied.join('、')}` : '') +
            '。这里没有 node_modules 等未跟踪的文件，需要时让 AI 安装依赖',
        );
        return sessions.get(info.id);
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        return reply.code(400).send({ error: e.message });
      }
    });

    /** Local branches of the repository containing a folder, for choosing a worktree's base. */
    priv.get<{ Querystring: { path?: string } }>('/api/fs/branches', async (req, reply) => {
      try {
        const roots = rootsOf(req.user!);
        const dir = await safeDir(req.query.path ?? '', roots);
        const repo = await mainRepo(dir);
        if (!inWorkspace(repo, roots)) throw new Error('这个仓库的根目录不在你能使用的文件夹内');
        const [list, current] = await Promise.all([
          tryGit(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']),
          tryGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD']),
        ]);
        return { branches: (list ?? '').split('\n').filter(Boolean).slice(0, 100), current };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    priv.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
      return sessions.get(req.params.id) ?? reply.code(404).send({ error: 'not found' });
    });

    /** The product advisor's memory files, for the memory panel. */
    priv.get<{ Params: { id: string } }>('/api/sessions/:id/memory', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      if (s.role !== 'advisor') return reply.code(404).send({ error: '这个会话不是管家' });
      return readAdvisorMemory(advisorDir(s.project, s.userId));
    });

    /** The briefs (需求书) the advisor has written, newest first. */
    priv.get<{ Params: { id: string } }>('/api/sessions/:id/briefs', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      if (s.role !== 'advisor') return reply.code(404).send({ error: '这个会话不是管家' });
      return listBriefs(advisorDir(s.project, s.userId));
    });

    /** Where every brief stands, with one line of conclusion. */
    priv.get<{ Params: { id: string } }>('/api/sessions/:id/progress', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s || s.role !== 'advisor') return reply.code(404).send({ error: 'not found' });
      return progress(s);
    });

    /** The advisor's automation settings (per project). */
    priv.get<{ Params: { id: string } }>('/api/sessions/:id/advisor-settings', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s || s.role !== 'advisor') return reply.code(404).send({ error: 'not found' });
      return readAdvisorSettings(advisorDir(s.project, s.userId));
    });

    priv.patch<{ Params: { id: string }; Body: Partial<AdvisorSettings> }>('/api/sessions/:id/advisor-settings', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s || s.role !== 'advisor') return reply.code(404).send({ error: 'not found' });
      const b = req.body ?? {};
      const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined);
      const patch: Partial<AdvisorSettings> = {};
      if (typeof b.autoHandoff === 'boolean') patch.autoHandoff = b.autoHandoff;
      if (typeof b.patrol === 'boolean') patch.patrol = b.patrol;
      if (typeof b.autoMerge === 'boolean') patch.autoMerge = b.autoMerge;
      if (typeof b.cleanupAfterMerge === 'boolean') patch.cleanupAfterMerge = b.cleanupAfterMerge;
      const n = { maxConcurrent: num(b.maxConcurrent, 1, 5), dailyLimit: num(b.dailyLimit, 1, 20), quotaStopPercent: num(b.quotaStopPercent, 10, 100), patrolHours: num(b.patrolHours, 1, 720) };
      for (const [k, v] of Object.entries(n)) if (v !== undefined) (patch as Record<string, number>)[k] = v;
      const before = readAdvisorSettings(advisorDir(s.project, s.userId));
      const next = writeAdvisorSettings(advisorDir(s.project, s.userId), patch);
      if (before.autoHandoff !== next.autoHandoff) sessions.note(s.id, next.autoHandoff ? `自动交接已打开：标了「可开工」的需求书会自动开工（同时最多 ${next.maxConcurrent} 个，每天最多 ${next.dailyLimit} 个，额度 ${next.quotaStopPercent}% 以上暂停）` : '自动交接已关闭');
      if (before.patrol !== next.patrol) sessions.note(s.id, next.patrol ? `定时巡视已打开：每 ${next.patrolHours} 小时一次` : '定时巡视已关闭');
      if (before.autoMerge !== next.autoMerge) sessions.note(s.id, next.autoMerge ? '自动合并已打开：管家说可以合并就合并进基础分支' : '自动合并已关闭');
      // Switched on: look for work right away instead of waiting for the advisor's next turn.
      if (!before.autoHandoff && next.autoHandoff) maybeAutoHandoff(s).catch((e: Error) => sessions.note(s.id, `自动交接失败：${e.message}`));
      return next;
    });

    /** Ends a brief's session that has nothing to merge: frees its slot and tells the advisor. */
    priv.post<{ Params: { id: string } }>('/api/sessions/:id/finish', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      if (sessions.isBusy(s.id)) return reply.code(409).send({ error: '会话正在运行，请等它结束' });
      try {
        await finishReport(s);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      return { ok: true };
    });

    /** Sends a coding session's report (its summary, as edited by the user) to the project's advisor as a message. */
    priv.post<{ Params: { id: string }; Body: { text?: string } }>('/api/sessions/:id/report', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      const pm = advisorFor(s);
      if (!pm) return reply.code(400).send({ error: '这个项目还没有管家' });
      const text = String(req.body?.text ?? '').trim();
      if (!text) return reply.code(400).send({ error: '汇报内容为空' });
      try {
        await report(s, pm, text, false);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      return { ok: true, advisorId: pm.id };
    });

    /** Hands a brief to a new coding session (own worktree); returns that session. */
    priv.post<{ Params: { id: string }; Body: { file?: string; options?: SessionOptions } }>('/api/sessions/:id/handoff', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      if (s.role !== 'advisor') return reply.code(404).send({ error: '这个会话不是管家' });
      try {
        return await handoffBrief(s, String(req.body?.file ?? ''), cleanOptions('claude', { ...CODING_OPTIONS, ...req.body?.options }));
      } catch (e) {
        if (e instanceof GitError || e instanceof Error) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    priv.patch<{ Params: { id: string }; Body: { title?: string; options?: SessionOptions } }>(
      '/api/sessions/:id',
      async (req, reply) => {
        const cur = sessions.get(req.params.id);
        if (!cur) return reply.code(404).send({ error: 'not found' });
        const options = req.body?.options ? cleanOptions(cur.agent, { ...cur.options, ...req.body.options }) : undefined;
        return sessions.update(cur.id, { title: req.body?.title?.trim() || undefined, options });
      },
    );

    priv.delete<{ Params: { id: string }; Querystring: { worktree?: string; force?: string } }>('/api/sessions/:id', async (req, reply) => {
      const meta = sessions.worktreeOf(req.params.id);
      if (meta && req.query.worktree === 'remove') {
        if (sessions.isBusy(req.params.id)) return reply.code(409).send({ error: '会话正在运行，请先停止' });
        sessions.release(req.params.id);
        try {
          await removeWorktree(meta, { force: req.query.force === '1', deleteBranch: true });
        } catch (e) {
          if (!(e instanceof GitError)) throw e;
          return reply.code(400).send({ error: e.message, code: e.code });
        }
      }
      const gone = sessions.get(req.params.id);
      sessions.delete(req.params.id);
      // A brief's session removed by hand frees a slot for automatic hand-off.
      if (gone && fromBrief(gone)) {
        const pm = advisorFor(gone);
        if (pm) maybeAutoHandoff(pm).catch(() => {});
      }
      return { ok: true };
    });

    // ---- share links: read-only, for anyone with the link (and its password) until it expires ----
    priv.get<{ Params: { id: string } }>('/api/sessions/:id/shares', async (req) => listShares(req.params.id));

    priv.post<{ Params: { id: string }; Body: { hours?: unknown; password?: unknown; live?: unknown } }>(
      '/api/sessions/:id/shares',
      async (req, reply) => {
        const hours = req.body?.hours === undefined ? SHARE_DEFAULT_HOURS : Number(req.body.hours);
        const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
        const problem = shareProblem(hours, password);
        if (problem) return reply.code(400).send({ error: problem });
        const share = createShare(req.params.id, { hours, password, live: req.body?.live !== false });
        req.log.info({ user: req.user!.username, session: req.params.id, hours, password: !!password }, 'session shared');
        return share;
      },
    );

    priv.delete<{ Params: { id: string; shareId: string } }>('/api/sessions/:id/shares/:shareId', async (req, reply) => {
      if (!deleteShare(req.params.id, req.params.shareId)) return reply.code(404).send({ error: '这个链接已经失效了' });
      return { ok: true };
    });

    // ---- the session's worktree ----
    priv.get<{ Params: { id: string } }>('/api/sessions/:id/worktree', async (req, reply) => {
      const meta = sessions.worktreeOf(req.params.id);
      if (!meta) return reply.code(404).send({ error: '这个会话没有使用 worktree' });
      return worktreeStatus(meta);
    });

    priv.post<{ Params: { id: string; action: string }; Body: { force?: boolean; deleteBranch?: boolean } }>(
      '/api/sessions/:id/worktree/:action',
      async (req, reply) => {
        const meta = sessions.worktreeOf(req.params.id);
        if (!meta) return reply.code(404).send({ error: '这个会话没有使用 worktree' });
        if (sessions.isBusy(req.params.id)) return reply.code(409).send({ error: '会话正在运行，请等它结束（或先停止）' });
        try {
          if (req.params.action === 'merge') {
            const summary = await mergeWorktree(meta);
            const s = sessions.get(req.params.id);
            if (s) mergedReport(s, summary).catch(() => {});
            return { ok: true, summary };
          }
          if (req.params.action === 'remove') {
            // The agent process works in that directory; stop it first.
            sessions.release(req.params.id);
            await removeWorktree(meta, { force: !!req.body?.force, deleteBranch: !!req.body?.deleteBranch });
            sessions.release(req.params.id);
            return { ok: true };
          }
          return reply.code(404).send({ error: '未知的操作' });
        } catch (e) {
          if (!(e instanceof GitError)) throw e;
          return reply.code(400).send({ error: e.message, code: e.code });
        }
      },
    );

    priv.get<{ Params: { id: string } }>('/api/sessions/:id/diff', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      return gitDiff(s.cwd);
    });

    // ---- git: status for any session, changes only inside the workspace ----
    priv.get<{ Params: { id: string } }>('/api/sessions/:id/git', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      return gitInfo(s.cwd);
    });

    type GitBody = { message?: string; files?: unknown; name?: unknown; email?: unknown; title?: unknown; body?: unknown; base?: unknown };
    const gitActions: Record<string, (cwd: string, b: GitBody) => Promise<unknown>> = {
      commit: (cwd, b) => commit(cwd, String(b.message ?? ''), b.files).then((summary) => ({ summary })),
      identity: (cwd, b) => setIdentity(cwd, b.name, b.email).then(() => ({})),
      push: (cwd) => push(cwd).then((output) => ({ output })),
      pull: (cwd) => pull(cwd).then((output) => ({ output })),
      branch: (cwd, b) => createBranch(cwd, b.name).then((branch) => ({ branch })),
      pr: (cwd, b) => createPr(cwd, b.title, b.body, b.base),
    };

    priv.post<{ Params: { id: string; action: string }; Body: GitBody }>('/api/sessions/:id/git/:action', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      const action = Object.hasOwn(gitActions, req.params.action) ? gitActions[req.params.action] : undefined;
      if (!action) return reply.code(404).send({ error: '未知的操作' });
      let cwd: string;
      try {
        cwd = await safeDir(s.cwd, rootsOf(req.user!));
      } catch {
        return reply.code(403).send({ error: req.user!.isAdmin ? '该会话的目录不在工作区内，只能查看' : '该会话的目录不在你的文件夹内，只能查看' });
      }
      try {
        const result = (await action(cwd, req.body ?? {})) as { url?: string };
        if (req.params.action === 'pr' && result.url) prReport(s, result.url).catch(() => {});
        return { ok: true, ...result };
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        return reply.code(400).send({ error: e.message, code: e.code });
      }
    });

    priv.get('/api/models', async () => getModels());

    // ---- attachments: raw file body, name in the query string ----
    priv.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) =>
      done(null, body),
    );

    priv.post<{ Params: { id: string }; Querystring: { name?: string }; Body: Buffer }>(
      '/api/sessions/:id/uploads',
      async (req, reply) => {
        if (!sessions.get(req.params.id)) return reply.code(404).send({ error: 'not found' });
        if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(400).send({ error: '空文件' });
        try {
          return saveUpload(req.params.id, String(req.query.name ?? 'file'), req.body);
        } catch (e) {
          return reply.code(400).send({ error: (e as Error).message });
        }
      },
    );

    priv.get<{ Params: { id: string; file: string } }>('/api/sessions/:id/uploads/:file', async (req, reply) => {
      const path = uploadPath(req.params.id, req.params.file);
      if (!path) return reply.code(404).send({ error: 'not found' });
      return sendUpload(reply, path, req.params.file);
    });

    // ---- quota ----
    priv.get<{ Querystring: { refresh?: string } }>('/api/usage', async (req) => getUsage(req.query.refresh === '1'));

    // ---- sessions stored locally by Claude Code / Codex: the machine owner's, so admins only ----
    priv.get<{ Querystring: { agent?: AgentKind } }>('/api/history', { preHandler: requireAdmin }, async (req, reply) => {
      const agent = AGENTS.includes(req.query.agent as AgentKind) ? req.query.agent : undefined;
      try {
        const linked = sessions.linkedIds();
        return (await listExternal(agent)).flatMap((s) => {
          const link = linked.get(`${s.agent}:${s.id}`);
          // Web sessions of other accounts are recorded there too; they stay theirs.
          if (link && link.userId !== req.user!.id) return [];
          const project = projectOf(s.cwd);
          return [{ ...s, project, subdir: subdirOf(s.cwd, project), importedAs: link?.id }];
        });
      } catch (e) {
        return reply.code(500).send({ error: `读取本机会话失败: ${(e as Error).message}` });
      }
    });

    priv.post<{ Body: { agent: AgentKind; id: string } }>('/api/history/import', { preHandler: requireAdmin }, async (req, reply) => {
      const { agent, id } = req.body ?? ({} as never);
      if (!AGENTS.includes(agent) || typeof id !== 'string') return reply.code(400).send({ error: '参数错误' });
      const linked = sessions.linkedIds().get(`${agent}:${id}`);
      if (linked && linked.userId !== req.user!.id) return reply.code(409).send({ error: '这个会话已经被另一个账号打开了' });
      if (linked) return sessions.get(linked.id);
      const ext = await externalInfo(agent, id);
      if (!ext) return reply.code(404).send({ error: '找不到该会话' });
      const info = sessions.importExternal(req.user!.id, ext, await loadHistory(agent, id, ext.cwd));
      sessions.setMark(info.id, await externalMark(agent, id, ext.cwd).catch(() => 0));
      return info;
    });

    // Older history, one page at a time, for scrolling up in a long session.
    priv.get<{ Params: { id: string }; Querystring: { before?: string } }>('/api/sessions/:id/events', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      const before = Number(req.query.before);
      if (!Number.isInteger(before) || before < 1) return reply.code(400).send({ error: 'before 参数无效' });
      return sessions.page(s.id, before);
    });

    // Whether the agent's own record changed after our last activity (e.g. continued in the CLI).
    priv.get<{ Params: { id: string } }>('/api/sessions/:id/sync-status', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      if (!s.agentSessionId) return { behind: false, holders: [] };
      const holders = s.agent === 'claude' ? claudeHoldersElsewhere(s.agentSessionId) : [];
      if (sessions.isBusy(s.id)) return { behind: false, holders };
      await sessions.markSettled(s.id);
      if (sessions.isBusy(s.id)) return { behind: false, holders };
      const current = await externalMark(s.agent, s.agentSessionId, s.cwd).catch(() => null);
      const seen = sessions.getMark(s.id);
      if (current === null) return { behind: false, holders };
      if (seen === null) {
        sessions.setMark(s.id, current);
        return { behind: false, holders };
      }
      return { behind: current > seen, holders };
    });

    priv.post<{ Params: { id: string } }>('/api/sessions/:id/resync', async (req, reply) => {
      const s = sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      if (!s.agentSessionId) return reply.code(400).send({ error: '该会话还没有对应的 CLI 记录' });
      try {
        sessions.resync(s.id, await loadHistory(s.agent, s.agentSessionId, s.cwd));
        sessions.setMark(s.id, await externalMark(s.agent, s.agentSessionId, s.cwd));
        return { ok: true };
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    });

    // ---- terminals: a raw shell runs with all of this machine's rights, so admins only ----
    priv.get('/api/terminals', async (req) => (req.user!.isAdmin ? terminals.list(req.user!.id) : []));

    priv.post<{ Body: { cwd: string; command?: string } }>('/api/terminals', { preHandler: requireAdmin }, async (req, reply) => {
      try {
        const cwd = await safeDir(req.body?.cwd);
        return terminals.create(req.user!.id, cwd, req.body?.command?.trim() || undefined);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    priv.delete<{ Params: { id: string } }>('/api/terminals/:id', async (req) => {
      terminals.kill(req.params.id);
      return { ok: true };
    });
  });
}
