// Zero-dependency stdio MCP bridge for Antigravity ACP -> ephemeral per-turn Unix-socket HTTP MCP endpoint.
import http from 'node:http';
import { createInterface } from 'node:readline';

const socketPath = process.env.ANYWHERE_MCP_SOCKET;
const endpoint = process.env.ANYWHERE_MCP_URL;
const token = process.env.ANYWHERE_MCP_TOKEN;
if ((!socketPath && !endpoint) || !token) {
  process.stderr.write('ANYWHERE_MCP_SOCKET (or ANYWHERE_MCP_URL) and ANYWHERE_MCP_TOKEN are required\n');
  process.exit(2);
}

const url = endpoint ? new URL(endpoint) : null;
const write = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');

function post(payload) {
  const raw = JSON.stringify(payload);
  const reqOpts = socketPath
    ? { socketPath, path: '/mcp', method: 'POST' }
    : { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST' };
  return new Promise((resolve, reject) => {
    const req = http.request({
      ...reqOpts,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
        'Authorization': 'Bearer ' + token,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'server/discover') {
    write({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  if (msg.method === 'initialize') {
    write({
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'anywhere_workspace', version: '0.4.0' },
      },
    });
    return;
  }
  if (msg.method === 'tools/list' || msg.method === 'tools/call') {
    try {
      const res = await post({ method: msg.method, params: msg.params ?? {} });
      if (res.error) write({ id: msg.id, error: res.error });
      else write({ id: msg.id, result: res.result });
    } catch (err) {
      write({ id: msg.id, error: { code: -32000, message: err?.message || 'Bridge error' } });
    }
    return;
  }
  write({ id: msg.id, error: { code: -32601, message: `Unsupported method: ${msg.method}` } });
});
