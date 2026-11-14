import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { userCount } from './auth.js';
import { config } from './config.js';
import { codexAppServer } from './external/codexAppServer.js';
import './loop.js';
import { adminRoutes } from './routes/admin.js';
import { apiRoutes } from './routes/api.js';
import { shareRoutes } from './routes/share.js';
import { wsRoutes } from './routes/ws.js';
import { sessions } from './sessions.js';
import { terminals } from './terminals.js';

// Only cloudflared (or a local reverse proxy) should reach this process.
const app = Fastify({ logger: { level: 'info' }, trustProxy: true, bodyLimit: 1024 * 1024 });

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
});

await app.register(apiRoutes);
await app.register(adminRoutes);
await app.register(shareRoutes);
await app.register(wsRoutes);

if (existsSync(config.webDist)) {
  // wildcard: files are looked up per request, so a rebuilt frontend is served without a restart.
  await app.register(fastifyStatic, { root: config.webDist, wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && req.url !== '/ws') {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });
} else {
  app.log.warn(`前端尚未构建（${config.webDist} 不存在）。开发时请使用 npm run dev 并访问 Vite 端口。`);
}

if (userCount() === 0) {
  app.log.warn('还没有任何用户。请先运行: npm run user -- add <用户名>');
}

const shutdown = async () => {
  // Open WebSockets (browsers) would otherwise keep app.close() waiting until systemd kills us.
  setTimeout(() => process.exit(0), 3000).unref();
  sessions.shutdown();
  terminals.shutdown();
  codexAppServer.stop();
  for (const client of app.websocketServer?.clients ?? []) client.terminate();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
app.log.info(`工作区根目录: ${config.workspaceRoots.join(', ')}`);
