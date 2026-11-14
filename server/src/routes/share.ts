import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { basename } from 'node:path';
import { account } from '../accounts.js';
import { clientIp, isSecureRequest, isThrottledKey, recordFailureKey } from '../auth.js';
import { sessions } from '../sessions.js';
import type { SessionInfo, SharedSession } from '../shared/protocol.js';
import { canRead, checkSharePassword, findShare, shareAccessKey, sharedAttachment, type ShareRow } from '../shares.js';
import { sendUpload, uploadPath } from '../uploads.js';

/** Set once the link's password was given; scoped to that link's API path. */
const COOKIE = 'ac_share';
const cookiePath = (id: string) => `/api/share/${id}`;

/** New events a live viewer may fetch in one go; further behind, it reloads the newest page instead. */
const MAX_NEWER = 500;

const lastPart = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function view(share: ShareRow, s: SessionInfo): SharedSession {
  const live = share.upto_seq === null;
  return {
    title: s.title,
    agent: s.agent,
    ...(s.role && { role: s.role }),
    owner: account(s.userId)?.username ?? '',
    project: s.remoteCwd ? lastPart(s.remoteCwd) : basename(s.project),
    cwd: s.remoteCwd ?? s.cwd,
    status: live ? s.status : 'idle',
    live,
    createdAt: share.created_at,
    expiresAt: share.expires_at,
  };
}

/**
 * Read-only links to a session, for people without an account: no login, only the
 * link (and its password, when it has one). Nothing here changes anything.
 */
export async function shareRoutes(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply) => {
    if (!req.url.startsWith('/api/share/')) return;
    reply.header('X-Robots-Tag', 'noindex');
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });

  /** The link's share and session; otherwise sends why not (404 gone or expired, 403 password needed) and returns null. */
  function open(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): { share: ShareRow; session: SessionInfo } | null {
    const share = findShare(req.params.id);
    const session = share && sessions.get(share.session_id);
    if (!share || !session) {
      reply.code(404).send({ error: '链接不存在或已经过期' });
      return null;
    }
    if (!canRead(share, req.cookies[COOKIE])) {
      reply.code(403).send({ error: '这个链接需要密码', code: 'password' });
      return null;
    }
    return { share, session };
  }

  app.get<{ Params: { id: string } }>('/api/share/:id', async (req, reply) => {
    const o = open(req, reply);
    if (!o) return reply;
    return { session: view(o.share, o.session), page: sessions.page(o.session.id, null, undefined, o.share.upto_seq ?? undefined) };
  });

  /** ?before=: an older page. ?after=: what happened since (live links). */
  app.get<{ Params: { id: string }; Querystring: { before?: string; after?: string } }>('/api/share/:id/events', async (req, reply) => {
    const o = open(req, reply);
    if (!o) return reply;
    const upto = o.share.upto_seq ?? undefined;
    if (req.query.before !== undefined) {
      const before = Number(req.query.before);
      if (!Number.isInteger(before) || before < 1) return reply.code(400).send({ error: 'before 参数无效' });
      return sessions.page(o.session.id, before, undefined, upto);
    }
    const after = Number(req.query.after);
    if (!Number.isInteger(after) || after < 0) return reply.code(400).send({ error: 'after 参数无效' });
    const events = sessions.events(o.session.id, after).filter((e) => upto === undefined || e.seq <= upto);
    const status = view(o.share, o.session).status;
    return events.length > MAX_NEWER ? { reset: true, events: [], status } : { events, status };
  });

  app.post<{ Params: { id: string }; Body: { password?: unknown } }>('/api/share/:id/unlock', async (req, reply) => {
    const share = findShare(req.params.id);
    if (!share || !sessions.get(share.session_id)) return reply.code(404).send({ error: '链接不存在或已经过期' });
    if (!share.password_hash) return { ok: true };
    // Per link and per address, like logins: a 4-character password still takes weeks to guess, and links last 7 days at most.
    const keys = [`share:${share.id}`, `share-ip:${clientIp(req)}`];
    if (isThrottledKey(...keys)) return reply.code(429).send({ error: '密码错误次数过多，请 15 分钟后再试' });
    if (!checkSharePassword(share, String(req.body?.password ?? '').trim())) {
      recordFailureKey(...keys);
      return reply.code(400).send({ error: '密码不对' });
    }
    reply.setCookie(COOKIE, shareAccessKey(share), {
      path: cookiePath(share.id),
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureRequest(req),
      maxAge: Math.max(1, Math.floor((share.expires_at - Date.now()) / 1000)),
    });
    return { ok: true };
  });

  /** Attachments sent in the shared part of the conversation (not files only uploaded, nor sent after a snapshot). */
  app.get<{ Params: { id: string; file: string } }>('/api/share/:id/uploads/:file', async (req, reply) => {
    const o = open(req, reply);
    if (!o) return reply;
    const path = sharedAttachment(o.share, req.params.file) ? uploadPath(o.session.id, req.params.file) : null;
    if (!path) return reply.code(404).send({ error: 'not found' });
    return sendUpload(reply, path, req.params.file);
  });
}
