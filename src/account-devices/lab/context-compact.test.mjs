import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createRequire } from 'node:module';
import { SessionStore } from '../../session-host/store.mjs';
import { CodexTurns } from '../../session-host/codex-turns.mjs';
import { AntigravityTurns } from '../../session-host/antigravity-turns.mjs';

const require = createRequire(import.meta.url);
const contract = require('../contract.cjs');

test('contract validates compactSession route strictly', () => {
  const sid = randomUUID();
  assert.doesNotThrow(() => contract.validate('compactSession', { sessionId: sid }));
  assert.throws(() => contract.validate('compactSession', {}), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('compactSession', { sessionId: 'bad' }), /INVALID_ID/);
});

test('CodexTurns.compact calls thread/compact/start and returns post-compaction context usage', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-compact-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sockPath = join(dir, 'codex.sock');
  const store = new SessionStore(join(dir, 'history.sqlite'));
  t.after(() => store.close());

  const seen = [];
  const srv = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => sock.write(JSON.stringify(obj) + '\n');
    rl.on('line', line => {
      const m = JSON.parse(line);
      seen.push(m.method);
      if (m.method === 'initialize') return send({ id: m.id, result: {} });
      if (m.method === 'thread/resume') return send({ id: m.id, result: { thread: { id: m.params.threadId }, model: 'gpt-5.4' } });
      if (m.method === 'thread/compact/start') {
        send({ id: m.id, result: {} });
        setTimeout(() => {
          send({ method: 'thread/compacted', params: { threadId: m.params.threadId, turnId: 'compact-1' } });
          send({ method: 'thread/tokenUsage/updated', params: { threadId: m.params.threadId, turnId: 'compact-1', tokenUsage: { last: { totalTokens: 18200, inputTokens: 18000, outputTokens: 200 }, modelContextWindow: 200000 } } });
          send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'compact-1', status: 'completed' } } });
        }, 15);
      }
    });
  });
  await new Promise(r => srv.listen(sockPath, r));
  t.after(() => srv.close());

  const codex = new CodexTurns({ store, emit() {}, delta() {} }, sockPath, dir);
  const res = await codex.compact({
    id: randomUUID(),
    codexThreadId: 'thr-123',
    options: { agent: 'codex', model: 'gpt-5.4' },
    contextUsage: { used: 150000, window: 200000 },
  });
  assert.ok(seen.includes('thread/resume'));
  assert.ok(seen.includes('thread/compact/start'));
  assert.equal(res.engine, 'codex');
  assert.equal(res.after.used, 18200);
  assert.equal(res.after.window, 200000);
});

test('AntigravityTurns.compact resumes session, sends /compact and captures updated usage_update', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-compact-agy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sockPath = join(dir, 'agy.sock');
  const store = new SessionStore(join(dir, 'history.sqlite'));
  t.after(() => store.close());

  const seenPrompts = [];
  const srv = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => sock.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
    rl.on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1 } });
      if (m.method === 'session/resume') return send({ id: m.id, result: { sessionId: m.params.sessionId } });
      if (m.method === 'session/prompt') {
        seenPrompts.push(m.params.prompt?.[0]?.text);
        send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Compacted summary.' } } } });
        send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'usage_update', used: 24100, size: 1048576 } } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
    });
  });
  await new Promise(r => srv.listen(sockPath, r));
  t.after(() => srv.close());

  const agy = new AntigravityTurns({ store, emit() {}, delta() {} }, sockPath, dir);
  const res = await agy.compact({
    id: randomUUID(),
    agySessionId: 'agy-sess-1',
    options: { agent: 'antigravity', model: 'gemini-4-neon' },
    contextUsage: { used: 183400, window: 1048576 },
  });
  assert.deepEqual(seenPrompts, ['/compact']);
  assert.equal(res.engine, 'antigravity');
  assert.equal(res.after.used, 24100);
  assert.equal(res.after.window, 1048576);
  assert.equal(res.summary, 'Compacted summary.');
});
