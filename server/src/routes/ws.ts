import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { account } from '../accounts.js';
import { COOKIE_NAME, sameOrigin, userFromToken } from '../auth.js';
import { sessions } from '../sessions.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import { terminals } from '../terminals.js';

/** Open connections and the login (cookie token) each was opened with. */
const live = new Map<WebSocket, { userId: number; token: string }>();

/**
 * Closes the account's connections whose login is no longer valid (password changed or reset,
 * account deleted). Clients take 4401 as "signed out".
 */
export function dropStaleSockets(userId: number) {
  for (const [ws, c] of live) if (c.userId === userId && !userFromToken(c.token)) ws.close(4401, 'unauthorized');
}

/** Makes the account's clients reconnect, e.g. after it lost admin rights: what they watch is checked again. */
export function reconnectSockets(userId: number) {
  for (const [ws, c] of live) if (c.userId === userId) ws.close(4000, 'reconnect');
}

export async function wsRoutes(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    const token = req.cookies[COOKIE_NAME];
    const user = sameOrigin(req) ? userFromToken(token) : null;
    if (!user || !token) {
      socket.close(4401, 'unauthorized');
      return;
    }
    live.set(socket, { userId: user.id, token });

    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const subscribed = new Set<string>();
    const termDetach = new Map<string, () => void>();
    const offGlobal = sessions.onGlobal(user.id, send);
    // Every session and terminal named in a message must belong to this account; admins may also
    // watch (only subscribe to) any other account's session.
    const mySession = (id: unknown) => typeof id === 'string' && sessions.ownerOf(id) === user.id;
    const canWatch = (id: unknown) =>
      mySession(id) || (typeof id === 'string' && sessions.ownerOf(id) !== undefined && !!account(user.id)?.isAdmin);
    const myTerm = (id: unknown) => typeof id === 'string' && terminals.owns(id, user.id);

    // Keeps the connection alive through Cloudflare's ~100s idle timeout.
    let alive = true;
    socket.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);

    socket.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if ('sessionId' in msg && msg.t !== 'unsub' && !(msg.t === 'sub' ? canWatch(msg.sessionId) : mySession(msg.sessionId))) {
        return send({ t: 'error', message: '会话不存在', sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined });
      }
      if ('termId' in msg && !myTerm(msg.termId)) {
        if (msg.t === 'term.attach') send({ t: 'term.exit', termId: msg.termId, code: -1 });
        return;
      }
      try {
        switch (msg.t) {
          case 'ping':
            return send({ t: 'pong' });
          case 'sub': {
            if (!subscribed.has(msg.sessionId)) {
              subscribed.add(msg.sessionId);
              sessions.subscribe(msg.sessionId, send);
            }
            // A fresh client gets the newest page only; it fetches older ones as the user scrolls up.
            if (!msg.afterSeq) {
              const { events, firstSeq, hasMore } = sessions.page(msg.sessionId, null);
              return send({ t: 'events', sessionId: msg.sessionId, events, page: { firstSeq, hasMore } });
            }
            return send({ t: 'events', sessionId: msg.sessionId, events: sessions.events(msg.sessionId, msg.afterSeq) });
          }
          case 'unsub':
            subscribed.delete(msg.sessionId);
            return sessions.unsubscribe(msg.sessionId, send);
          case 'send':
            await sessions.send(msg.sessionId, msg.text ?? '', Array.isArray(msg.attachments) ? msg.attachments.map(String) : []);
            return;
          case 'compact':
            return await sessions.compact(msg.sessionId);
          case 'interrupt':
            return await sessions.interrupt(msg.sessionId);
          case 'perm': {
            const { t: _t, sessionId, ...answer } = msg;
            if (!sessions.answerPermission(sessionId, answer)) send({ t: 'error', message: '该请求已失效' });
            return;
          }
          case 'mode':
            return await sessions.setPermissionMode(msg.sessionId, msg.mode);
          case 'effort':
            return await sessions.setEffort(msg.sessionId, msg.effort);
          case 'model':
            if (msg.model !== null && (typeof msg.model !== 'string' || !/^[\w.:\[\]-]{1,80}$/.test(msg.model))) return;
            return await sessions.setModel(msg.sessionId, msg.model);
          case 'approval':
            if (!['on-request', 'untrusted', 'never'].includes(msg.policy)) return;
            return await sessions.setApprovalPolicy(msg.sessionId, msg.policy);
          case 'sandbox':
            if (!['read-only', 'workspace-write', 'danger-full-access'].includes(msg.mode)) return;
            return sessions.setSandboxMode(msg.sessionId, msg.mode);
          case 'term.attach': {
            termDetach.get(msg.termId)?.();
            const detach = terminals.attach(
              msg.termId,
              (data) => send({ t: 'term.out', termId: msg.termId, data }),
              (code) => send({ t: 'term.exit', termId: msg.termId, code }),
            );
            if (detach) termDetach.set(msg.termId, detach);
            else send({ t: 'term.exit', termId: msg.termId, code: -1 });
            return;
          }
          case 'term.detach':
            termDetach.get(msg.termId)?.();
            termDetach.delete(msg.termId);
            return;
          case 'term.in':
            return terminals.write(msg.termId, msg.data);
          case 'term.resize':
            return terminals.resize(msg.termId, msg.cols, msg.rows);
        }
      } catch (e) {
        const sessionId = 'sessionId' in msg ? msg.sessionId : undefined;
        send({ t: 'error', message: e instanceof Error ? e.message : String(e), sessionId });
      }
    });

    socket.on('close', () => {
      live.delete(socket);
      clearInterval(heartbeat);
      offGlobal();
      for (const id of subscribed) sessions.unsubscribe(id, send);
      for (const off of termDetach.values()) off();
    });
  });
}
