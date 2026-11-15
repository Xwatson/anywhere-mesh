import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkClient } from './client.mjs';

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-helper-test-'));
  const path = join(directory, 'control.sock');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        handler(request, socket);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true });
  });
  return path;
}
const reply = (socket, request, extra = {}) => socket.write(JSON.stringify({
  version: 1, id: request.id, ok: true, status: { phase: 'connected' }, ...extra,
}) + '\n');

test('concurrent close sends exactly one stop and releases timers', async (t) => {
  let stops = 0;
  const path = await fixture(t, (request, socket) => {
    if (request.method === 'start') reply(socket, request, { lease: 'test-lease', leaseSeconds: 5 });
    else if (request.method === 'stop') {
      stops++;
      assert.equal(request.lease, 'test-lease');
      setTimeout(() => reply(socket, request), 20);
    } else reply(socket, request);
  });
  const client = await NetworkClient.connect(path);
  await client.acquire();
  await Promise.all([client.close(), client.close(), client.close()]);
  assert.equal(stops, 1);
  await assert.rejects(client.status(), /CLIENT_CLOSED/);
});

test('helper disconnect rejects all pending requests without reconnecting', async (t) => {
  const path = await fixture(t, (_, socket) => socket.destroy());
  const client = await NetworkClient.connect(path);
  const states = await Promise.allSettled([client.status(), client.status()]);
  assert.ok(states.every((s) => s.status === 'rejected'));
  await assert.rejects(client.acquire(), /CLIENT_CLOSED/);
  await client.close();
});

test('oversized response without newline closes control channel', async (t) => {
  const path = await fixture(t, (_, socket) => socket.write('x'.repeat(5000)));
  const client = await NetworkClient.connect(path);
  await assert.rejects(client.status(), /RESPONSE_TOO_LARGE/);
  await client.close();
});
