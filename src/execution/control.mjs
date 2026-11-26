import http from 'node:http';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { exact, fail } from './protocol.mjs';

export async function serveControl(socketPath, broker) {
  // This socket is in the service-owned state directory, inaccessible to other users.
  // The local lab group is the explicitly trusted mock-adapter/control boundary.
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = http.createServer(async (req, res) => {
    const respond = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (req.method !== 'POST' || req.url !== '/rpc') fail('NOT_FOUND');
      const parts = []; let bytes = 0;
      for await (const part of req) { bytes += part.length; if (bytes > 65536) fail('FRAME_TOO_LARGE'); parts.push(part); }
      const request = JSON.parse(Buffer.concat(parts).toString('utf8')); exact(request, ['method', 'params']);
      respond(200, { result: await broker.control(request.method, request.params) });
    } catch (e) { respond(400, { error: e.code || 'INVALID_REQUEST' }); }
  });
  server.headersTimeout = 15000; server.requestTimeout = 40000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o660); return server;
}
export function control(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/rpc', method: 'POST', timeout: 35000,
      headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = []; let bytes = 0;
      res.on('data', (c) => { bytes += c.length; if (bytes > 1048576) req.destroy(new Error('RESPONSE_TOO_LARGE')); else chunks.push(c); });
      res.on('end', () => { try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (result.error) reject(new Error(result.error)); else resolve(result.result); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('CONTROL_TIMEOUT')));
    req.end(JSON.stringify({ method, params }));
  });
}
