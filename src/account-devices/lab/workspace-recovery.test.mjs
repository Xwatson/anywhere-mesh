import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Broker } from '../../execution/broker.mjs';
import { serveControl } from '../../execution/control.mjs';
import { grantFor } from '../../execution/grants.mjs';
import { Journal } from '../../execution/journal.mjs';
import { id } from '../../execution/protocol.mjs';
import { register } from '../../desktop-commander/adapter.mjs';
import { AntigravityTurns } from '../../session-host/antigravity-turns.mjs';
import { CodexTurns } from '../../session-host/codex-turns.mjs';
import { SessionHost } from '../../session-host/runtime.mjs';
import { TurnToolGuard } from '../../session-host/tool-budget.mjs';
import { linuxWorkspace } from '../linux-workspace.mjs';

register();

async function createBrokerHarness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-ws-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wsId = randomUUID();
  const deviceId = randomUUID();
  const baseGrant = grantFor({ accountId: '1', deviceId, workspaceId: wsId }, 'execute', 2);
  const brokerDir = join(dir, 'broker');
  mkdirSync(brokerDir, { recursive: true });
  const brokerJournal = new Journal(join(brokerDir, 'journal.sqlite'));
  const broker = new Broker(brokerJournal, baseGrant, { workspace: { label: 'recovery-repo', reliability: true } });
  broker.grant = baseGrant;
  broker.phase = 'ready';
  broker.workspaceStatus = { sandbox: { network: true, readOnly: false } };
  const ctrlServer = await serveControl(join(brokerDir, 'control.sock'), broker);

  const hostStateDir = join(dir, 'host');
  mkdirSync(hostStateDir, { recursive: true });
  const host = new SessionHost({
    stateDir: hostStateDir,
    accountId: '1',
    requireDeviceBinding: true,
    workspaces: [{ id: wsId, label: 'recovery-repo', brokerDir, grant: baseGrant }],
  });
  host.antigravity = new AntigravityTurns(host, join(dir, 'agy.sock'), dir);
  host.codex = new CodexTurns(host, join(dir, 'codex.sock'), dir);

  t.after(async () => {
    await host.close();
    ctrlServer.close();
    broker.close();
    brokerJournal.close();
  });

  return { dir, wsId, deviceId, grant: baseGrant, broker, host };
}

function makeTurn(host, wsId, grant, engine, { codexTurnId = null } = {}) {
  const s = host.store.create(
    { requestId: randomUUID(), workspaceId: wsId, title: `test-${engine}` },
    grant,
  );
  const turnId = randomUUID();
  const bindingTurnId = codexTurnId ?? turnId;
  const turn = {
    id: turnId,
    sessionId: s.id,
    workspaceId: wsId,
    createdAt: Date.now(),
    state: 'running',
    done: false,
    consumed: false,
    engine,
    text: 'check',
    attachments: [],
    calls: [],
    modelTurnId: bindingTurnId,
    binding: {
      accountId: grant.accountId,
      deviceId: grant.deviceId,
      workspaceId: wsId,
      grantVersion: grant.grantVersion,
      sessionId: s.id,
      turnId: bindingTurnId,
      turnEpoch: 1,
    },
  };
  host.store.put('turns', turnId, turn);
  host.store.put('sessions', s.id, { ...s, activeTurnId: turnId, ...(engine === 'codex' ? { codexThreadId: 'thr-1' } : {}) });
  return { session: s, turn };
}

test('Antigravity and Codex recover transient CONTROL_TIMEOUT during dispatch instead of abandoning unconsumed blockers', async t => {
  const { wsId, grant, broker, host } = await createBrokerHarness(t);

  // --- Antigravity ---
  const agy = makeTurn(host, wsId, grant, 'antigravity');
  const agyHost = await host.host(agy.turn);
  const origAgyCall = agyHost.client.callTool.bind(agyHost.client);
  let agyFirstCall = true;
  agyHost.client.callTool = async (req) => {
    if (agyFirstCall && req.name === 'workspace_read_file') {
      agyFirstCall = false;
      // Simulate broker.dispatch taking > control timeout: op transitions to succeeded asynchronously while callTool returns CONTROL_TIMEOUT (no task).
      const op = broker.journal.all('ops').find(o => o.request.scope.turnId === agy.turn.id);
      assert.ok(op);
      setTimeout(() => {
        broker.merge({
          ...op,
          taskId: id(),
          state: 'succeeded',
          result: { exitCode: 0, signal: null, tool: { version: 1, ok: true, response: { content: [{ type: 'text', text: 'RECOVERED_AGY_CONTENT' }] } } },
          lastSeq: 0,
          starts: 1,
        });
      }, 60);
      return {
        isError: true,
        content: [{ type: 'text', text: 'CONTROL_TIMEOUT' }],
        structuredContent: { error: 'CONTROL_TIMEOUT' },
      };
    }
    return origAgyCall(req);
  };

  const agyRun = {
    ending: false,
    callSeq: 0,
    tools: new Set(['workspace_read_file']),
    guard: new TurnToolGuard(),
    touch() {},
  };
  const agyRes = await host.antigravity.invokeMcpTool(agy.turn, agyRun, {
    name: 'workspace_read_file',
    arguments: { path: 'app.js', offset: 0, length: 20 },
    _meta: { progressToken: 'agy-call-1' },
  });
  assert.equal(agyRes.isError, false);
  assert.equal(agyRes.content[0].text, 'RECOVERED_AGY_CONTENT');
  assert.deepEqual(broker.blockers(wsId), []);

  // --- Codex ---
  const codex = makeTurn(host, wsId, grant, 'codex', { codexTurnId: 'codex-turn-1' });
  const codexHost = await host.host(codex.turn);
  const origCodexCall = codexHost.client.callTool.bind(codexHost.client);
  let codexFirstCall = true;
  codexHost.client.callTool = async (req) => {
    if (codexFirstCall && req.name === 'workspace_read_file') {
      codexFirstCall = false;
      const op = broker.journal.all('ops').find(o => o.request.scope.turnId === 'codex-turn-1');
      assert.ok(op);
      setTimeout(() => {
        broker.merge({
          ...op,
          taskId: id(),
          state: 'succeeded',
          result: { exitCode: 0, signal: null, tool: { version: 1, ok: true, response: { content: [{ type: 'text', text: 'RECOVERED_CODEX_CONTENT' }] } } },
          lastSeq: 0,
          starts: 1,
        });
      }, 60);
      return {
        isError: true,
        content: [{ type: 'text', text: 'CONTROL_TIMEOUT' }],
        structuredContent: { error: 'CONTROL_TIMEOUT' },
      };
    }
    return origCodexCall(req);
  };

  const codexRun = {
    ending: false,
    threadId: 'thr-1',
    ready: { promise: Promise.resolve('codex-turn-1') },
    tools: new Set(['workspace_read_file']),
    guard: new TurnToolGuard(),
    touch() {},
  };
  const codexRes = await host.codex.call(codex.turn, codexRun, 'item/tool/call', {
    threadId: 'thr-1',
    turnId: 'codex-turn-1',
    callId: 'codex-call-1',
    tool: 'workspace_read_file',
    arguments: { path: 'app.js', offset: 0, length: 20 },
  });
  assert.equal(codexRes.success, true);
  assert.equal(codexRes.contentItems[0].text, 'RECOVERED_CODEX_CONTENT');
  assert.deepEqual(broker.blockers(wsId), []);
});

test('reconcileWorkspaceBlockers self-heals unconsumed terminal op from another active turn while preserving unknown review fence', async t => {
  const { wsId, grant, broker, host } = await createBrokerHarness(t);

  // Session A issues an op that succeeds on the broker but stays unconsumed (delivery === 'pending').
  const sessA = makeTurn(host, wsId, grant, 'antigravity');
  const hA = await host.host(sessA.turn);
  host.store.upsertTurnCall({
    turnId: sessA.turn.id,
    sessionId: sessA.session.id,
    callId: 'call-a-1',
    tool: 'workspace_read_file',
    effectiveTool: 'workspace_read_file',
    inputHash: 'ih-a',
    argsSummary: { path: 'a.js' },
    state: 'dispatched',
    counted: true,
  });
  const ticketA = await hA.executor.issue('call-a-1', 'workspace_read_file', { path: 'a.js', offset: 0, length: 10 });
  const opA = broker.get(ticketA.operationId);
  broker.merge({
    ...opA,
    taskId: id(),
    state: 'succeeded',
    result: { exitCode: 0, signal: null, tool: { version: 1, ok: true, response: { content: [{ type: 'text', text: 'FROM_A' }] } } },
    lastSeq: 0,
    starts: 1,
  });
  assert.deepEqual(broker.blockers(wsId).map(o => o.operationId), [ticketA.operationId]);

  // Session B enters waitForWorkspaceReady -> reconcileWorkspaceBlockers should capture & consume opA cleanly.
  const sessB = makeTurn(host, wsId, grant, 'antigravity');
  const info = await host.reconcileWorkspaceBlockers(wsId, { waitMs: 3000 });
  assert.equal(info.phase, 'ready');
  assert.deepEqual(info.blockers, []);
  assert.equal(broker.get(ticketA.operationId).delivery, 'consumed');
  assert.equal(host.store.getTurnCall(sessA.turn.id, 'call-a-1').consumed, true);
  assert.equal(host.store.get('agyResults', ticketA.operationId), undefined, 'ephemeral agyResults must be purged immediately after consumeAfterPersist');
  assert.ok(host.store.page(sessA.session.id, 0).events.some(e => e.event.type === 'tool_call' && e.event.output === 'FROM_A'));

  // Now Session B can immediately issue a fresh op without WORKSPACE_RECOVERING.
  const hB = await host.host(sessB.turn);
  const ticketB = await hB.executor.issue('call-b-1', 'workspace_read_file', { path: 'b.js', offset: 0, length: 10 });
  const opB = broker.get(ticketB.operationId);

  // Turn opB into 'unknown' (agent restart mid-execution): reconcileWorkspaceBlockers must NOT bypass or stall on it.
  broker.merge({
    ...opB,
    taskId: id(),
    state: 'unknown',
    reason: 'agent_restart_requires_review',
    result: null,
    lastSeq: 0,
    starts: 1,
  });
  const started = Date.now();
  const unknownInfo = await host.reconcileWorkspaceBlockers(wsId, { waitMs: 5000 });
  assert.ok(Date.now() - started < 1000, 'must return immediately on unknownOperations instead of waiting out waitMs');
  assert.deepEqual(unknownInfo.unknownOperations, [ticketB.operationId]);
  await assert.rejects(() => hB.executor.issue('call-b-2', 'workspace_read_file', { path: 'c.js', offset: 0, length: 10 }), /WORKSPACE_RECOVERING/);
});

test('preloadProjectDocs drains and consumes timed-out preload ops instead of stranding blockers', async t => {
  const { wsId, grant, broker, host } = await createBrokerHarness(t);
  const { turn } = makeTurn(host, wsId, grant, 'antigravity');

  // Make broker.control('dispatch') fail once with CONTROL_TIMEOUT after op is prepared, while op becomes cancelled on cancel RPC.
  const origBroker = host.broker.bind(host);
  let dispatchFailed = false;
  host.broker = async (w, method, params) => {
    if (method === 'dispatch' && !dispatchFailed) {
      dispatchFailed = true;
      throw Error('CONTROL_TIMEOUT');
    }
    if (method === 'cancel') {
      const op = broker.get(params.operationId);
      broker.merge({ ...op, taskId: id(), state: 'cancelled', reason: 'cancelled_before_launch', result: { exitCode: null, signal: null }, lastSeq: 0, starts: 0 });
      return { cancelId: 'c1', confirmed: true, state: 'cancelled' };
    }
    return origBroker(w, method, params);
  };

  const docs = await host.preloadProjectDocs(turn);
  assert.deepEqual(docs, []);
  assert.deepEqual(broker.blockers(wsId), []);
  assert.deepEqual(broker.journal.all('ops').filter(o => o.delivery !== 'consumed'), []);
});

test('linuxWorkspace async searchWorkspace and listDirTree work and honor AbortSignal', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-linux-async-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'demo.txt'), 'alpha\nNEEDLE_TOKEN\nomega\n');

  const ws = linuxWorkspace();
  const rootId = ws.identifyRoot(dir);
  const launch = ws.launcher({ workspaceRoot: dir, rootIdentity: rootId, readOnly: true });

  const searchSpec = launch(
    { request: { kind: 'dc.search', cwdRelative: '.', args: { path: '.', pattern: 'NEEDLE_TOKEN', searchType: 'content', literalSearch: true, maxResults: 10 } } },
    { capabilities: ['dc.tool', 'dc.search'] },
  );
  const res = await searchSpec.read(new AbortController().signal);
  assert.equal(res.ok, true);
  assert.match(res.response.content[0].text, /sub\/demo\.txt:2:/);

  const listSpec = launch(
    { request: { kind: 'dc.tool', cwdRelative: '.', args: { tool: 'list_directory', arguments: { path: '.', depth: 2 } } } },
    { capabilities: ['dc.tool', 'dc.search'] },
  );
  const listRes = await listSpec.read(new AbortController().signal);
  assert.match(listRes.response.content[0].text, /sub\/demo\.txt/);

  // Pre-aborted signal cleanly aborts async read/search.
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => searchSpec.read(aborted.signal), /READ_CANCELLED/);
  await assert.rejects(() => listSpec.read(aborted.signal), /READ_CANCELLED/);
});

test('SessionStore scales capacity, subtracts freelist on remove, and prunes leaked consumed result caches', async t => {
  const { SessionStore } = await import('../../session-host/store.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-store-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'history.sqlite');

  // 1. Default limits: Journal = 256 MiB, SessionStore = 512 MiB
  const j = new Journal(join(dir, 'ws.sqlite'));
  assert.equal(j.storage().maxBytes, 256 * 1024 * 1024);
  j.close();

  const store = new SessionStore(dbPath);
  assert.equal(store.storage().maxBytes, 512 * 1024 * 1024);

  // 2. Inject leaked consumed agyResults/codexResults and stale unsubmitted marker, then reopen to verify startup prune.
  const wsId = randomUUID();
  const sess = store.create({ requestId: randomUUID(), workspaceId: wsId, title: 'Leak Test' });
  store.put('turns', 'turn-done', { id: 'turn-done', sessionId: sess.id, done: true, consumed: true });
  store.put('receipts', 'op-leaked-1', { resultDigest: 'd1', receiptId: 'antigravity:op-leaked-1' });
  store.put('agyResults', 'op-leaked-1', { reply: { content: [{ type: 'text', text: 'A'.repeat(20000) }] } });
  store.put('agyResults', 'op-unconsumed', { reply: { content: [{ type: 'text', text: 'KEEP_ME' }] } });
  store.put('agyUnsubmitted', 'turn-done:call-1', true);
  store.close();

  const reopened = new SessionStore(dbPath);
  t.after(() => reopened.close());
  assert.equal(reopened.get('agyResults', 'op-leaked-1'), undefined);
  assert.ok(reopened.get('agyResults', 'op-unconsumed'), 'unconsumed result cache must be preserved');
  assert.equal(reopened.get('agyUnsubmitted', 'turn-done:call-1'), undefined);

  // 3. Removing a heavy session frees pages via freelist accounting + WAL checkpoint so ensureCapacity succeeds.
  const bigSess = reopened.create({ requestId: randomUUID(), workspaceId: wsId, title: 'Heavy' });
  for (let i = 0; i < 40; i++) {
    reopened.append(bigSess.id, { type: 'assistant_text', id: `m-${i}`, text: 'Z'.repeat(8000) });
  }
  reopened.checkpoint();
  const fullBytes = reopened.storage().bytes;
  assert.ok(fullBytes > 200 * 1024);

  reopened.maxHistoryBytes = fullBytes + 32 * 1024;
  assert.throws(() => reopened.ensureCapacity(64 * 1024), /HISTORY_STORAGE_FULL/);

  reopened.remove(bigSess.id);
  const afterRemoveBytes = reopened.storage().bytes;
  assert.ok(afterRemoveBytes < fullBytes - 150 * 1024, `expected freelist reclamation (${afterRemoveBytes} < ${fullBytes})`);
  assert.doesNotThrow(() => reopened.ensureCapacity(64 * 1024));
});
