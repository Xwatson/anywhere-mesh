import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { TurnLaunchLimiter } from '../../session-host/launch-limiter.mjs';

test('TurnLaunchLimiter enforces 5-10s random stagger per engine, zero wait when idle, and compaction on cancel', async t => {
  // 1. Verify default 5000..10000ms random sampling bounds
  const defaultLimiter = new TurnLaunchLimiter();
  t.after(() => defaultLimiter.close());
  for (let i = 0; i < 40; i++) {
    const sample = defaultLimiter.sampleDelay();
    assert.ok(sample >= 5000 && sample <= 10000, `Expected 5000..10000ms, got ${sample}`);
  }

  // 2. Deterministic timing & per-engine independence
  const samples = [180, 140, 160, 150];
  let idx = 0;
  const limiter = new TurnLaunchLimiter({
    minDelayMs: 120,
    maxDelayMs: 200,
    sampleDelay: () => samples[idx++ % samples.length],
  });
  t.after(() => limiter.close());

  // First codex turn enters immediately (0ms wait)
  const c1 = limiter.enqueue('codex', 'turn-c1');
  assert.equal(c1.queued, false);
  assert.equal(c1.remainingMs, 0);
  assert.equal(await c1.wait, true);

  // Simultaneous antigravity turn ALSO enters immediately (independent engine queue!)
  const a1 = limiter.enqueue('antigravity', 'turn-a1');
  assert.equal(a1.queued, false);
  assert.equal(a1.remainingMs, 0);
  assert.equal(await a1.wait, true);

  // Second and third simultaneous codex turns queue behind c1's cooldown without waiting for c1 to finish
  const updatesC3 = [];
  const c2 = limiter.enqueue('codex', 'turn-c2');
  const c3 = limiter.enqueue('codex', 'turn-c3', { onUpdate: info => updatesC3.push(info) });
  assert.equal(c2.queued, true);
  assert.equal(c2.position, 1);
  assert.ok(c2.remainingMs > 0 && c2.remainingMs <= 185);
  assert.equal(c3.queued, true);
  assert.equal(c3.position, 2);
  assert.ok(c3.remainingMs > c2.remainingMs);

  // Cancel middle item c2 -> c3 immediately compacts to position 1 with shorter wait
  assert.equal(limiter.cancel('turn-c2'), true);
  assert.equal(await c2.wait, false);
  const st3 = limiter.status('turn-c3');
  assert.equal(st3?.position, 1);
  assert.ok(updatesC3.some(u => u.position === 1));

  // c3 enters once cooldown elapses
  const enteredC3 = await c3.wait;
  assert.equal(enteredC3, true);
  assert.equal(limiter.status('turn-c3'), null);

  // Wait past c3's cooldown -> next codex turn enters immediately (0ms wait)
  await new Promise(r => setTimeout(r, 210));
  const c4 = limiter.enqueue('codex', 'turn-c4');
  assert.equal(c4.queued, false);
  assert.equal(c4.remainingMs, 0);
});

test('concurrent sessions on the same project run in parallel with per-engine launch queueing, countdown state, and safe tool serialization', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-launch-queue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const authDir = join(dir, 'auth');
  const hostState = join(dir, 'host-state');
  const clientStateA = join(dir, 'client-a');
  const clientStateB = join(dir, 'client-b');
  const projectA = join(dir, 'project-a');
  const projectB = join(dir, 'project-b');
  for (const p of [authDir, hostState, clientStateA, clientStateB, projectA, projectB]) mkdirSync(p, { recursive: true });
  writeFileSync(join(projectA, 'notes.txt'), 'SHARED_WORKSPACE_LINE_1\n');
  writeFileSync(join(projectB, 'notes.txt'), 'USER2_WORKSPACE_LINE_1\n');

  const keyPath = join(dir, 'server.key');
  const certPath = join(dir, 'server.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });

  // Mock Codex server that holds Turn 1 open for 650ms so Turn 2 enters WHILE Turn 1 is still active,
  // and both execute workspace_read_file on the SAME projectA workspace!
  const codexSocket = join(dir, 'codex.sock');
  const codexEntered = [];
  let codexTurnSeq = 0;
  const codexServer = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => { if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n'); };
    let threadId = null;
    let currentTurnId = null;
    let turnNum = 0;
    rl.on('line', line => {
      const m = JSON.parse(line);
      if (m.id === 'tool-req-1' && m.result !== undefined) {
        const holdMs = turnNum === 1 ? 520 : 40;
        const replyText = m.result?.contentItems?.[0]?.text ?? '';
        setTimeout(() => {
          send({ method: 'item/completed', params: { threadId, turnId: currentTurnId, item: { id: 'msg-' + turnNum, type: 'agentMessage', text: `Codex#${turnNum}:${replyText.trim()}` } } });
          send({ method: 'turn/completed', params: { threadId, turn: { id: currentTurnId, status: 'completed', durationMs: holdMs } } });
        }, holdMs);
        return;
      }
      if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
      if (m.method === 'model/list') {
        send({ id: m.id, result: { data: [{ id: 'gpt-5.4', displayName: 'GPT-5.4', supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium', isDefault: true }] } });
        return;
      }
      if (m.method === 'thread/start' || m.method === 'thread/resume') {
        threadId = m.params.threadId ?? ('thread-' + randomUUID().slice(0, 8));
        send({ id: m.id, result: { thread: { id: threadId }, model: 'gpt-5.4' } });
        return;
      }
      if (m.method === 'turn/interrupt') {
        send({ id: m.id, result: {} });
        return;
      }
      if (m.method === 'turn/start') {
        turnNum = ++codexTurnSeq;
        currentTurnId = 'turn-' + turnNum + '-' + randomUUID().slice(0, 6);
        codexEntered.push({ turnNum, at: Date.now(), prompt: m.params.input?.[0]?.text ?? '' });
        send({ id: m.id, result: { turn: { id: currentTurnId, status: 'inProgress' } } });
        setTimeout(() => {
          send({
            id: 'tool-req-1',
            method: 'item/tool/call',
            params: { threadId, turnId: currentTurnId, callId: 'call-' + turnNum, tool: 'workspace_read_file', arguments: { path: 'notes.txt', offset: 0, length: 5 } },
          });
        }, 20);
      }
    });
  });
  await new Promise(resolve => codexServer.listen(codexSocket, resolve));
  t.after(() => codexServer.close());

  // Mock Antigravity ACP server to verify independent per-engine queue
  const agySocket = join(dir, 'agy.sock');
  const agyEntered = [];
  const agyServer = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => { if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n'); };
    let mcpProc = null;
    sock.on('close', () => { try { mcpProc?.kill(); } catch {} });
    rl.on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') {
        send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        return;
      }
      if (m.method === 'session/new' || m.method === 'session/resume') {
        const mcpDef = m.params?.mcpServers?.[0];
        if (mcpDef) {
          const env = { ...process.env };
          for (const e of mcpDef.env ?? []) env[e.name] = e.value;
          mcpProc = spawn(mcpDef.command, mcpDef.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        }
        send({ jsonrpc: '2.0', id: m.id, result: { sessionId: m.params.sessionId ?? ('agy-' + randomUUID().slice(0, 8)), models: { availableModels: [] }, configOptions: [] } });
        return;
      }
      if (m.method === 'session/prompt') {
        agyEntered.push({ at: Date.now() });
        const sid = m.params.sessionId;
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Antigravity immediate ok' } } } });
        send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      }
    });
  });
  await new Promise(resolve => agyServer.listen(agySocket, resolve));
  t.after(() => agyServer.close());

  process.env.DATA_DIR = authDir;
  const { createUser } = await import('../auth.mjs');
  const { db } = await import('../auth-db.mjs');
  const { startServer } = await import('../host.mjs');
  const { DeviceClient } = await import('../client.mjs');

  createUser('alice', 'alice strong pass', false);
  createUser('bob', 'bob strong pass 2', false);

  const server = await startServer({
    host: '127.0.0.1', port: 0, cert: certPath, key: keyPath,
    stateDir: hostState, codexSocket, codexCwd: dir,
    antigravitySocket: agySocket, antigravityCwd: dir,
    antigravityMcpDir: dir,
    mcpPath: join(import.meta.dirname, '../wan/mcp.mjs'),
    launchLimiter: { minDelayMs: 260, maxDelayMs: 320 },
  });
  t.after(async () => { await server.close(); db.close(); });

  const streamA = [];
  const clientA = new DeviceClient({
    name: 'Alice Linux', url: `https://127.0.0.1:${server.port}`, ca: certPath, stateDir: clientStateA,
    projects: [{ label: 'Project A', path: projectA }],
  }, {
    onStream: msg => streamA.push(msg),
    launcher: () => () => ({
      read: async () => {
        await new Promise(r => setTimeout(r, 45));
        return { version: 1, ok: true, calls: 1, response: { content: [{ type: 'text', text: 'SHARED_WORKSPACE_LINE_1' }] } };
      },
    }),
  });
  const clientB = new DeviceClient({
    name: 'Bob Linux', url: `https://127.0.0.1:${server.port}`, ca: certPath, stateDir: clientStateB,
    projects: [{ label: 'Project B', path: projectB }],
  }, {
    launcher: () => () => ({
      read: async () => ({ version: 1, ok: true, calls: 1, response: { content: [{ type: 'text', text: 'USER2_WORKSPACE_LINE_1' }] } }),
    }),
  });
  t.after(async () => { await Promise.allSettled([clientA.disconnect(false), clientB.disconnect(false)]); });

  await clientA.act('login', { username: 'alice', password: 'alice strong pass' });
  await clientB.act('login', { username: 'bob', password: 'bob strong pass 2' });

  let stA, stB;
  for (let i = 0; i < 40; i++) {
    [stA, stB] = await Promise.all([clientA.act('state'), clientB.act('state')]);
    if (stA.projects[0]?.ready && stB.projects[0]?.ready) break;
    await new Promise(r => setTimeout(r, 60));
  }
  const wsA = stA.projects[0].id;
  const wsB = stB.projects[0].id;
  await Promise.all([
    clientA.act('permission', { workspaceId: wsA, mode: 'read' }),
    clientB.act('permission', { workspaceId: wsB, mode: 'read' }),
  ]);
  for (let i = 0; i < 40; i++) {
    [stA, stB] = await Promise.all([clientA.act('state'), clientB.act('state')]);
    if (stA.projects[0]?.mode === 'read' && stB.projects[0]?.mode === 'read') break;
    await new Promise(r => setTimeout(r, 60));
  }

  // Create 3 sessions on Alice's SAME workspace (2 Codex + 1 Antigravity) and 1 existing Codex session on Bob
  const s1 = await clientA.act('create', { workspaceId: wsA, requestId: randomUUID(), title: '会话 1 (Codex)', options: { agent: 'codex' } });
  const s2 = await clientA.act('create', { workspaceId: wsA, requestId: randomUUID(), title: '会话 2 (Codex 并发)', options: { agent: 'codex' } });
  const sAgy = await clientA.act('create', { workspaceId: wsA, requestId: randomUUID(), title: '会话 3 (Antigravity 独立队列)', options: { agent: 'antigravity' } });
  const sBob = await clientB.act('create', { workspaceId: wsB, requestId: randomUUID(), title: 'Bob 会话 (跨用户共享限流)', options: { agent: 'codex' } });

  await clientA.act('subscribe', { sessionId: s2.id, afterSeq: 0 });
  await new Promise(r => setTimeout(r, 40));

  const t0 = Date.now();
  // Send Session 1 (Codex) -> enters immediately!
  const sent1 = await clientA.act('send', { sessionId: s1.id, requestId: randomUUID(), text: '读取第一行 #1' });
  assert.equal(Boolean(sent1.activeTurn?.queued), false);

  // Immediately send Session 2 on SAME workspace (Codex) -> NO WORKSPACE_NOT_READY, enters queued state!
  const sent2 = await clientA.act('send', { sessionId: s2.id, requestId: randomUUID(), text: '读取第一行 #2' });
  assert.equal(sent2.activeTurn?.queued, true);
  assert.equal(sent2.activeTurn?.state, 'queued');
  assert.equal(sent2.activeTurn?.queuePosition, 1);
  assert.ok(sent2.activeTurn?.queueRemainingMs > 0);

  // Immediately send Antigravity session on SAME workspace -> independent queue, starts immediately with 0 wait!
  const sentAgy = await clientA.act('send', { sessionId: sAgy.id, requestId: randomUUID(), text: 'Antigravity 并发测试' });
  assert.equal(Boolean(sentAgy.activeTurn?.queued), false);

  // Immediately send Bob's Codex session (different user!) -> shares Codex rate limiter, queued at position 2, then cancel it!
  const sentBob = await clientB.act('send', { sessionId: sBob.id, requestId: randomUUID(), text: 'Bob 同时发信' });
  assert.equal(sentBob.activeTurn?.queued, true);
  assert.equal(sentBob.activeTurn?.queuePosition, 2);

  // Verify /api/state exposes live countdown for s2
  const midState = await clientA.act('state');
  const midS2 = midState.sessions.find(x => x.id === s2.id);
  assert.equal(midS2?.activeTurn?.queued, true);
  assert.ok(typeof midS2?.activeTurn?.queueRemainingMs === 'number');

  // Bob cancels while queued -> immediately clears activeTurn without hitting Codex!
  await clientB.act('stop', { sessionId: sBob.id, turnId: sentBob.turnId, requestId: randomUUID() });
  const bobStateAfterStop = await clientB.act('state');
  assert.equal(bobStateAfterStop.sessions.find(x => x.id === sBob.id)?.activeTurn, null);
  const bobHist = await clientB.act('history', { sessionId: sBob.id, afterSeq: 0 });
  assert.match(bobHist.events.find(e => e.event.type === 'turn_end')?.event.error ?? '', /已取消排队/);

  // Wait for s1, s2, and sAgy to all complete
  for (let i = 0; i < 80; i++) {
    const cur = await clientA.act('state');
    const busyCount = cur.sessions.filter(x => x.activeTurn).length;
    if (busyCount === 0) break;
    await new Promise(r => setTimeout(r, 60));
  }

  // Verify only 2 Codex turns entered (Bob's cancelled queued turn never hit Codex)
  assert.equal(codexEntered.length, 2);
  // Turn 2 entered after the ~260-320ms stagger (allowing cold-start delta on Turn 1), BEFORE Turn 1 finished (~540ms)!
  const gapMs = codexEntered[1].at - codexEntered[0].at;
  assert.ok(gapMs >= 200 && gapMs < 500, `Expected Turn 2 to enter after stagger (~260-320ms) without waiting for Turn 1 (540ms), got gap=${gapMs}ms`);
  // Antigravity entered immediately without waiting for Codex cooldown!
  assert.equal(agyEntered.length, 1);
  assert.ok(agyEntered[0].at - t0 < 220, `Expected Antigravity to start immediately, took ${agyEntered[0].at - t0}ms`);

  // Verify SSE stream received queue unblocking delta for s2
  assert.ok(streamA.some(m => m.type === 'delta' && m.payload?.sessionId === s2.id && m.payload?.delta?.kind === 'queue' && m.payload.delta.queued === false));

  // Verify both concurrent Codex sessions on the same workspace succeeded with real tool output
  const [h1, h2, hAgy] = await Promise.all([
    clientA.act('history', { sessionId: s1.id, afterSeq: 0 }),
    clientA.act('history', { sessionId: s2.id, afterSeq: 0 }),
    clientA.act('history', { sessionId: sAgy.id, afterSeq: 0 }),
  ]);
  assert.equal(h1.events.find(e => e.event.type === 'turn_end')?.event.ok, true);
  assert.equal(h2.events.find(e => e.event.type === 'turn_end')?.event.ok, true);
  assert.equal(hAgy.events.find(e => e.event.type === 'turn_end')?.event.ok, true);
  assert.ok(h1.events.some(e => e.event.type === 'assistant_text' && e.event.text.includes('SHARED_WORKSPACE_LINE_1')));
  assert.ok(h2.events.some(e => e.event.type === 'assistant_text' && e.event.text.includes('SHARED_WORKSPACE_LINE_1')));

  // Also test existing session follow-up message enters queue when sent during cooldown!
  const f1 = await clientA.act('send', { sessionId: s1.id, requestId: randomUUID(), text: '已有会话继续发消息 #1' });
  const f2 = await clientA.act('send', { sessionId: s2.id, requestId: randomUUID(), text: '已有会话继续发消息 #2' });
  assert.equal(Boolean(f1.activeTurn?.queued || f2.activeTurn?.queued), true, 'Follow-up turns sent simultaneously must also go through the engine launch queue');
  for (let i = 0; i < 80; i++) {
    const cur = await clientA.act('state');
    if (cur.sessions.every(x => !x.activeTurn)) break;
    await new Promise(r => setTimeout(r, 60));
  }
});
