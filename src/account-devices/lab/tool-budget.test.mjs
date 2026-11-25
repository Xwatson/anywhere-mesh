import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { hash } from '../../execution/protocol.mjs';
import { grantFor } from '../../execution/grants.mjs';
import { SessionStore } from '../../session-host/store.mjs';
import { CodexTurns } from '../../session-host/codex-turns.mjs';
import { AntigravityTurns } from '../../session-host/antigravity-turns.mjs';
import {
  DEFAULT_TOOL_BUDGET,
  TurnToolGuard,
  appendAgyWarning,
  appendCodexWarning,
  boundEventInput,
  classifyTool,
  isMutationTool,
  resolveToolBudget,
  summarizeCallArgs,
} from '../../session-host/tool-budget.mjs';
import { isRenderableEvent } from '../ui/session-cache.js';

function httpPostUnix(socketPath, token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      socketPath,
      path: '/mcp',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('tool-budget policy resolution, classification, argument compaction and TurnToolGuard guardrails', () => {
  const def = resolveToolBudget({}, {});
  assert.equal(def.maxTotalCalls, 240);
  assert.equal(def.maxMutationCalls, 120);
  assert.equal(def.maxLocalCalls, 60);
  assert.equal(def.maxConsecutiveFailures, 10);
  assert.equal(def.maxConsecutiveIdentical, 5);
  assert.equal(def.maxConsecutiveIdenticalFailures, 3);

  // Overrides & clamping
  const custom = resolveToolBudget({ maxTotalCalls: 12, maxMutationCalls: 50 }, { ANYWHERE_MAX_TOOL_CALLS: '99' });
  assert.equal(custom.maxTotalCalls, 12);
  assert.equal(custom.maxMutationCalls, 12);
  assert.equal(custom.warnRemainingTotal, 4);

  const fromEnv = resolveToolBudget({}, { ANYWHERE_MAX_TOOL_CALLS: '300', ANYWHERE_MAX_MUTATION_CALLS: '150', ANYWHERE_MAX_CONSECUTIVE_FAILURES: '6' });
  assert.equal(fromEnv.maxTotalCalls, 300);
  assert.equal(fromEnv.maxMutationCalls, 150);
  assert.equal(fromEnv.maxConsecutiveFailures, 6);

  // Tool classification
  assert.equal(classifyTool('workspace_read_file'), 'read');
  assert.equal(classifyTool('workspace_search'), 'read');
  assert.equal(isMutationTool('workspace_read_files'), false);
  assert.equal(classifyTool('workspace_write_file'), 'mutation');
  assert.equal(classifyTool('workspace_run'), 'mutation');
  assert.equal(classifyTool('session_send_attachment'), 'mutation');
  assert.equal(isMutationTool('workspace_apply_patch'), true);
  assert.equal(classifyTool('session_read_attachment'), 'local');
  assert.equal(classifyTool('memory_save'), 'local');

  // Argument summarization & event bounding
  const small = { path: 'src/a.js', offset: 0, length: 50 };
  assert.deepEqual(summarizeCallArgs(small), small);
  assert.deepEqual(boundEventInput(small), small);

  const huge = {
    path: 'src/big.js',
    mode: 'rewrite',
    expectedRevision: null,
    content: 'A'.repeat(120000),
  };
  const summary = summarizeCallArgs(huge);
  assert.equal(summary.path, 'src/big.js');
  assert.equal(summary.mode, 'rewrite');
  assert.ok(Buffer.byteLength(JSON.stringify(summary), 'utf8') <= 4096);
  assert.match(summary.content, /truncated, 120000 chars/);

  const bounded = boundEventInput(huge);
  assert.equal(bounded.path, 'src/big.js');
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 16384);

  // Differentiated read vs mutation budgets + soft warnings
  const guard = new TurnToolGuard({
    maxTotalCalls: 5,
    maxMutationCalls: 2,
    warnRemainingTotal: 2,
    warnRemainingMutations: 1,
    maxConsecutiveFailures: 4,
    maxConsecutiveIdentical: 3,
    maxConsecutiveIdenticalFailures: 2,
  });

  // 1st mutation -> remaining mutations = 1 -> mutation soft warning
  assert.equal(guard.checkWorkspace('workspace_write_file', 'h1').allowed, true);
  guard.recordWorkspaceDispatched('workspace_write_file');
  guard.recordWorkspaceOutcome('workspace_write_file', 'h1', true);
  assert.match(guard.softWarning('workspace_write_file'), /1 write\/execute call remaining/);

  // 2nd mutation -> remaining mutations = 0 -> mutation exhausted notice, still allows read!
  assert.equal(guard.checkWorkspace('workspace_run', 'h2').allowed, true);
  guard.recordWorkspaceDispatched('workspace_run');
  guard.recordWorkspaceOutcome('workspace_run', 'h2', true);
  assert.match(guard.softWarning('workspace_run'), /Write\/execute tool budget exhausted/);

  const mutBlocked = guard.checkWorkspace('workspace_edit_file', 'h3');
  assert.equal(mutBlocked.allowed, false);
  assert.equal(mutBlocked.code, 'mutation_limit');
  assert.ok(mutBlocked.notice?.canContinue);

  // Read still allowed up to maxTotalCalls (5)
  assert.equal(guard.checkWorkspace('workspace_read_file', 'r1').allowed, true);
  guard.recordWorkspaceDispatched('workspace_read_file');
  guard.recordWorkspaceOutcome('workspace_read_file', 'r1', true);
  assert.match(guard.softWarning('workspace_read_file'), /2 workspace tool calls remaining/);

  // Warning helpers do not mutate original replies
  const origCodex = { success: true, contentItems: [{ type: 'inputText', text: 'ok' }] };
  const warnedCodex = appendCodexWarning(origCodex, '[warn]');
  assert.equal(origCodex.contentItems[0].text, 'ok');
  assert.equal(warnedCodex.contentItems[0].text, 'ok\n\n[warn]');

  const origAgy = { isError: false, content: [{ type: 'text', text: 'ok' }] };
  const warnedAgy = appendAgyWarning(origAgy, '[warn]');
  assert.equal(origAgy.content[0].text, 'ok');
  assert.equal(warnedAgy.content[0].text, 'ok\n\n[warn]');

  // Loop & consecutive failure breaker
  const loopGuard = new TurnToolGuard({
    maxTotalCalls: 20,
    maxMutationCalls: 20,
    maxConsecutiveFailures: 4,
    maxConsecutiveIdentical: 3,
    maxConsecutiveIdenticalFailures: 2,
  });
  for (let i = 0; i < 2; i++) {
    assert.equal(loopGuard.checkWorkspace('workspace_run', 'same-fail').allowed, true);
    loopGuard.recordWorkspaceDispatched('workspace_run');
    loopGuard.recordWorkspaceOutcome('workspace_run', 'same-fail', false);
  }
  // 3rd identical failing call blocked (targeted loop guard, no user notice)
  const identFail = loopGuard.checkWorkspace('workspace_run', 'same-fail');
  assert.equal(identFail.allowed, false);
  assert.equal(identFail.code, 'identical_failure_loop');
  assert.equal(identFail.notice, undefined);

  // A different call still works, and succeeding resets consecutiveFailures!
  assert.equal(loopGuard.checkWorkspace('workspace_read_file', 'other-ok').allowed, true);
  loopGuard.recordWorkspaceDispatched('workspace_read_file');
  loopGuard.recordWorkspaceOutcome('workspace_read_file', 'other-ok', true);
  assert.equal(loopGuard.consecutiveFailures, 0);

  // 3 consecutive identical succeeding calls -> 4th blocked
  for (let i = 0; i < 3; i++) {
    assert.equal(loopGuard.checkWorkspace('workspace_read_file', 'poll-same').allowed, true);
    loopGuard.recordWorkspaceDispatched('workspace_read_file');
    loopGuard.recordWorkspaceOutcome('workspace_read_file', 'poll-same', true);
  }
  const identOk = loopGuard.checkWorkspace('workspace_read_file', 'poll-same');
  assert.equal(identOk.allowed, false);
  assert.equal(identOk.code, 'identical_call_loop');

  // 4 consecutive failures with distinct args trip circuit breaker
  let tripped = false;
  for (let i = 0; i < 4; i++) {
    assert.equal(loopGuard.checkWorkspace('workspace_run', 'fail-' + i).allowed, true);
    loopGuard.recordWorkspaceDispatched('workspace_run');
    const out = loopGuard.recordWorkspaceOutcome('workspace_run', 'fail-' + i, false);
    if (out.circuitTrippedNow) tripped = true;
  }
  assert.equal(tripped, true);
  const broken = loopGuard.checkWorkspace('workspace_read_file', 'brand-new');
  assert.equal(broken.allowed, false);
  assert.equal(broken.code, 'consecutive_failures');
  assert.equal(loopGuard.markNoticeEmitted('consecutive_failures'), true);
  assert.equal(loopGuard.markNoticeEmitted('consecutive_failures'), false);

  // Local tool limit
  const localGuard = new TurnToolGuard({ maxLocalCalls: 2 });
  assert.equal(localGuard.checkLocal().allowed, true);
  localGuard.recordLocal();
  assert.equal(localGuard.checkLocal().allowed, true);
  localGuard.recordLocal();
  const localBlocked = localGuard.checkLocal();
  assert.equal(localBlocked.allowed, false);
  assert.equal(localBlocked.code, 'local_tool_limit');

  assert.equal(DEFAULT_TOOL_BUDGET.maxTotalCalls, 240);
  assert.equal(isRenderableEvent({ type: 'turn_notice', title: 'x' }), true);
});

test('SessionStore turn_calls prevents O(N^2) turn bloat, supports pageBefore turn_notice, and cleans up on session remove', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-turn-calls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, 'history.sqlite'));
  t.after(() => store.close());

  const wsId = randomUUID();
  const s = store.create({ requestId: randomUUID(), workspaceId: wsId, title: 'Calls DB' }, { accountId: '1', deviceId: randomUUID() });
  const turnId = randomUUID();

  for (let i = 0; i < 120; i++) {
    const args = { path: `src/f${i}.js`, content: 'x'.repeat(60000), mode: 'rewrite', expectedRevision: null };
    store.upsertTurnCall({
      turnId,
      sessionId: s.id,
      callId: `c-${i}`,
      tool: 'workspace_write_file',
      effectiveTool: 'workspace_write_file',
      inputHash: hash({ i }),
      argsSummary: summarizeCallArgs(args),
      state: 'completed',
      ok: true,
      consumed: i < 118,
      counted: true,
      operationId: `op-${i}`,
    });
  }

  assert.equal(store.hasTurnCalls(turnId), true);
  assert.equal(store.listTurnCalls(turnId).length, 120);
  assert.equal(store.listTurnCalls(turnId, { onlyUnconsumed: true }).length, 2);
  const first = store.getTurnCall(turnId, 'c-0');
  assert.equal(first.argsSummary.path, 'src/f0.js');
  assert.ok(Buffer.byteLength(JSON.stringify(first.argsSummary), 'utf8') <= 4096);

  store.append(s.id, { type: 'user_message', text: 'hi' });
  store.append(s.id, { type: 'turn_notice', code: 'tool_limit', title: '上限', detail: '240/240', canContinue: true });
  const tail = store.pageBefore(s.id, 100);
  assert.ok(tail.events.some(r => r.event.type === 'turn_notice'));

  store.remove(s.id);
  assert.equal(store.listTurnCalls(turnId).length, 0);
});

function createMockHostHarness(store, wsId, grant, { failWhen = () => false, allowWrite = () => true } = {}) {
  const workspaceEntry = { id: wsId, label: 'test-repo', grant };
  const stats = {
    issueCalls: 0,
    recoverCalls: 0,
    consumeCalls: 0,
    reasoningIdleCalls: 0,
    stopTurnCalls: 0,
    hostOpenCalls: 0,
  };
  const opsByCallId = new Map();
  const opsById = new Map();
  let opSeq = 0;

  const brokerControl = async (method) => {
    if (method === 'workspace') {
      const mode = allowWrite() ? 'execute' : 'read';
      const activeGrant = grantFor({
        accountId: grant.accountId,
        deviceId: grant.deviceId,
        workspaceId: wsId,
      }, mode, grant.grantVersion);
      return {
        phase: 'ready',
        confirmed: true,
        label: 'test-repo',
        grant: activeGrant,
        blockers: [],
        unknownOperations: [],
        activeOperations: [],
        sandbox: { network: true, readOnly: false },
      };
    }
    if (method === 'reasoningIdle') { stats.reasoningIdleCalls += 1; return { ok: true }; }
    if (method === 'stopTurn') { stats.stopTurnCalls += 1; return { ok: true }; }
    return { ok: true };
  };

  const hosts = new Map();
  const host = {
    store,
    workspaces: new Map([[wsId, workspaceEntry]]),
    closing: false,
    workspace(id) { if (id !== wsId) throw Error('WORKSPACE_NOT_ALLOWED'); return workspaceEntry; },
    session(id) { return store.session(id); },
    broker: (_w, m, p) => brokerControl(m, p),
    withWorkspaceLock: (_id, fn) => fn(),
    emit: () => {},
    delta: () => {},
    preloadProjectDocs: async () => [],
    async host(t) {
      if (hosts.has(t.id)) return hosts.get(t.id);
      stats.hostOpenCalls += 1;
      const h = {
        executor: {
          async issue(callId, toolName, args) {
            stats.issueCalls += 1;
            const existing = opsByCallId.get(callId);
            if (existing) return { ticket: 'tk-' + existing.operationId, operationId: existing.operationId, requestHash: 'rh' };
            const operationId = `op-${++opSeq}`;
            const rec = { callId, operationId, toolName, args, consumed: false };
            opsByCallId.set(callId, rec);
            opsById.set(operationId, rec);
            return { ticket: 'tk-' + operationId, operationId, requestHash: 'rh' };
          },
          async recover(callId) {
            stats.recoverCalls += 1;
            const rec = opsByCallId.get(callId);
            return rec ? { operationId: rec.operationId, requestHash: 'rh' } : null;
          },
          async status(operationId) {
            const rec = opsById.get(operationId);
            return {
              isError: false,
              content: [{ type: 'text', text: `recovered:${rec?.toolName ?? 'unknown'}` }],
              structuredContent: {
                version: 1,
                workspaceId: wsId,
                task: { operationId, state: 'succeeded', resultReady: true, resultDigest: 'd-' + operationId, receivedSeq: 0, lastSeq: 0 },
                result: { fileVersions: [] },
              },
            };
          },
          async consumeAfterPersist({ operationId }) {
            stats.consumeCalls += 1;
            const rec = opsById.get(operationId);
            if (rec) rec.consumed = true;
            return { consumed: true };
          },
        },
        client: {
          async callTool({ name, arguments: args, _meta }) {
            const ticket = _meta?.['anywhere/callTicket'] ?? '';
            const operationId = ticket.replace(/^tk-/, '');
            const shouldFail = Boolean(failWhen(name, args, operationId));
            return {
              isError: shouldFail,
              content: [{ type: 'text', text: shouldFail ? `failed:${name}` : `ok:${name}:${args.path ?? args.command ?? ''}` }],
              structuredContent: {
                version: 1,
                workspaceId: wsId,
                task: {
                  operationId,
                  state: shouldFail ? 'failed' : 'succeeded',
                  resultReady: true,
                  resultDigest: 'd-' + operationId,
                  receivedSeq: 0,
                  lastSeq: 0,
                },
                result: { fileVersions: [] },
              },
            };
          },
        },
      };
      hosts.set(t.id, h);
      return h;
    },
    async closeHost(id) { hosts.delete(id); },
  };
  return { host, stats, opsByCallId, opsById };
}

test('CodexTurns handles >60 calls with O(1) reconcile, differentiated mutation cap, pre-dispatch refund, and soft warnings', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-codex-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, 'history.sqlite'));
  t.after(() => store.close());

  const wsId = randomUUID();
  const deviceId = randomUUID();
  const grant = grantFor({ accountId: '1', deviceId, workspaceId: wsId }, 'execute', 1);
  let writeAllowed = true;
  const { host, stats } = createMockHostHarness(store, wsId, grant, { allowWrite: () => writeAllowed });

  const codexSocket = join(dir, 'codex.sock');
  let runNo = 0;
  const run2Replies = [];

  const server = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => { if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n'); };
    const idx = ++runNo;
    let threadId = null, turnId = null;
    let step = 0;

    const sendCall = (id, callId, tool, args) => send({
      id, method: 'item/tool/call', params: { threadId, turnId, callId, tool, arguments: args },
    });

    const finishTurn = text => {
      send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'msg-' + idx, type: 'agentMessage', text } } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', durationMs: 25 } } });
    };

    rl.on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
      if (m.method === 'thread/start') {
        threadId = 'thr-' + idx;
        send({ id: m.id, result: { thread: { id: threadId }, model: 'gpt-5.4' } });
        return;
      }
      if (m.method === 'turn/start') {
        turnId = 'turn-' + idx;
        send({ id: m.id, result: { turn: { id: turnId } } });
        if (idx === 1) {
          // Run 1: 75 distinct read calls (exceeds legacy 60 cap!)
          step = 1;
          sendCall(step, `read-${step}`, 'workspace_read_file', { path: `src/file-${step}.js`, offset: 0, length: 20 });
        } else {
          // Run 2: pre-dispatch failure (revoked write) -> 2 writes (large 80 KiB file!) -> blocked 3rd write -> allowed read
          step = 1;
          writeAllowed = false;
          sendCall(1, 'pre-fail-write', 'workspace_write_file', { path: 'a.js', content: 'hi', mode: 'rewrite', expectedRevision: null });
        }
        return;
      }
      if (idx === 1 && m.id === step) {
        assert.equal(m.result.success, true);
        if (step < 75) {
          step += 1;
          sendCall(step, `read-${step}`, 'workspace_read_file', { path: `src/file-${step}.js`, offset: 0, length: 20 });
        } else {
          finishTurn('Read all 75 files cleanly.');
        }
        return;
      }
      if (idx === 2 && m.id === step) {
        run2Replies.push(m.result);
        if (step === 1) {
          // Pre-dispatch permission failure must NOT consume budget; re-enable write and do 1st large write
          writeAllowed = true;
          step = 2;
          sendCall(2, 'write-1', 'workspace_write_file', { path: 'big.txt', content: 'Z'.repeat(80000), mode: 'rewrite', expectedRevision: null });
        } else if (step === 2) {
          step = 3;
          sendCall(3, 'write-2', 'workspace_write_file', { path: 'small.txt', content: 'v2', mode: 'rewrite', expectedRevision: null });
        } else if (step === 3) {
          step = 4;
          sendCall(4, 'write-3-blocked', 'workspace_write_file', { path: 'third.txt', content: 'v3', mode: 'rewrite', expectedRevision: null });
        } else if (step === 4) {
          step = 5;
          sendCall(5, 'write-4-blocked-again', 'workspace_write_file', { path: 'fourth.txt', content: 'v4', mode: 'rewrite', expectedRevision: null });
        } else if (step === 5) {
          step = 6;
          sendCall(6, 'read-still-ok', 'workspace_read_file', { path: 'small.txt', offset: 0, length: 10 });
        } else {
          finishTurn('Wrapped up after hitting write cap.');
        }
      }
    });
  });
  await new Promise(resolve => server.listen(codexSocket, resolve));
  t.after(() => server.close());

  const makeTurn = (sessionId, text) => {
    const turnId = randomUUID();
    const turn = {
      id: turnId, sessionId, workspaceId: wsId, createdAt: Date.now(),
      state: 'preparing', done: false, consumed: false, engine: 'codex',
      text, attachments: [], calls: [], historyBefore: 0,
      binding: { accountId: '1', deviceId, workspaceId: wsId, grantVersion: 1, sessionId, turnId, turnEpoch: 1 },
    };
    store.tx(() => {
      store.append(sessionId, { type: 'user_message', text });
      store.put('sessions', sessionId, { ...store.session(sessionId), activeTurnId: turnId });
      store.put('turns', turnId, turn);
    });
    return turn;
  };

  // Run 1: default budget (240 total), 75 reads
  const codexDefault = new CodexTurns(host, codexSocket, dir);
  const s1 = store.create({ requestId: randomUUID(), workspaceId: wsId, title: '75 reads' }, grant);
  const t1 = makeTurn(s1.id, 'Read 75 files');
  await codexDefault.run(t1);

  assert.equal(stats.issueCalls, 75);
  assert.equal(stats.consumeCalls, 75);
  assert.equal(stats.recoverCalls, 0, 'reconcile() must skip already-consumed calls (0 redundant recover IPCs)');
  assert.equal(stats.reasoningIdleCalls, 1);
  // Turn JSON must stay lean (no calls array growth) and ephemeral codexResults must be purged
  const persistedTurn1 = store.get('turns', t1.id);
  assert.equal(persistedTurn1.calls.length, 0);
  assert.equal(store.all('codexResults').length, 0);
  const s1Events = store.page(s1.id, 0).events.concat(store.page(s1.id, 50).events);
  const s1End = store.pageBefore(s1.id, 9999).events.find(r => r.event.type === 'turn_end')?.event;
  assert.equal(s1End.ok, true);
  assert.deepEqual(s1End.toolCalls, { total: 75, mutations: 0 });
  assert.ok(s1Events.length > 0);

  // Run 2: custom small budget to verify pre-dispatch refund + large write event bounding + mutation cap + read fallback
  const codexTight = new CodexTurns(host, codexSocket, dir, {
    toolBudget: { maxTotalCalls: 5, maxMutationCalls: 2, warnRemainingTotal: 2, warnRemainingMutations: 1 },
  });
  const s2 = store.create({ requestId: randomUUID(), workspaceId: wsId, title: 'Tight budget' }, grant);
  const t2 = makeTurn(s2.id, 'Edit with tight cap');
  await codexTight.run(t2);

  // Step 1: pre-dispatch permission denied (did NOT count against mutation budget!)
  assert.equal(run2Replies[0].success, false);
  assert.match(run2Replies[0].contentItems[0].text, /Workspace permission changed/);
  // Step 2: 1st write succeeded + soft warning for remaining 1 mutation
  assert.equal(run2Replies[1].success, true);
  assert.match(run2Replies[1].contentItems[0].text, /1 write\/execute call remaining/);
  // Step 3: 2nd write succeeded + soft warning for exhausted write budget
  assert.equal(run2Replies[2].success, true);
  assert.match(run2Replies[2].contentItems[0].text, /Write\/execute tool budget exhausted/);
  // Step 4 & 5: 3rd & 4th writes blocked by mutation_limit
  assert.equal(run2Replies[3].success, false);
  assert.match(run2Replies[3].contentItems[0].text, /Write\/execute tool budget reached/);
  assert.equal(run2Replies[4].success, false);
  // Step 6: read-only tool still succeeded after mutation cap!
  assert.equal(run2Replies[5].success, true);
  assert.match(run2Replies[5].contentItems[0].text, /ok:workspace_read_file:small\.txt/);

  // UI events: exactly ONE deduplicated turn_notice, no soft-warning leak into chat_events, pre-dispatch call marked failed
  const s2All = store.page(s2.id, 0).events.map(r => r.event);
  const notices = s2All.filter(e => e.type === 'turn_notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].code, 'mutation_limit');
  assert.equal(notices[0].canContinue, true);
  const preFailDone = s2All.filter(e => e.type === 'tool_call' && e.id === 'pre-fail-write').at(-1);
  assert.equal(preFailDone.status, 'failed');
  const write1Done = s2All.filter(e => e.type === 'tool_call' && e.id === 'write-1').at(-1);
  assert.equal(write1Done.status, 'completed');
  assert.doesNotMatch(write1Done.output, /AnywhereMesh Budget/);
  const s2End = s2All.find(e => e.type === 'turn_end');
  assert.deepEqual(s2End.toolCalls, { total: 3, mutations: 2 });
});

test('AntigravityTurns handles >60 calls, loop detection, consecutive failure breaker and crash reconcile', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-agy-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, 'history.sqlite'));
  t.after(() => store.close());

  const wsId = randomUUID();
  const deviceId = randomUUID();
  const grant = grantFor({ accountId: '1', deviceId, workspaceId: wsId }, 'execute', 1);
  let failCommands = false;
  const { host, stats, opsByCallId, opsById } = createMockHostHarness(store, wsId, grant, {
    failWhen: name => failCommands && name === 'workspace_run',
  });

  const agySocket = join(dir, 'agy.sock');
  let runNo = 0;
  const breakerResults = [];

  const agyServer = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => { if (!sock.destroyed) sock.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n'); };
    const idx = ++runNo;
    let mcpSock = null, mcpToken = null;
    const sessionId = 'agy-sess-' + idx;

    rl.on('line', async line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') { send({ id: m.id, result: { protocolVersion: 1 } }); return; }
      if (m.method === 'session/new') {
        const srv = m.params.mcpServers[0];
        mcpSock = srv.env.find(e => e.name === 'ANYWHERE_MCP_SOCKET').value;
        mcpToken = srv.env.find(e => e.name === 'ANYWHERE_MCP_TOKEN').value;
        send({ id: m.id, result: { sessionId, models: { currentModelId: 'gemini-4-neon-high', availableModels: [] } } });
        return;
      }
      if (m.method === 'session/prompt') {
        if (idx === 1) {
          // 70 read calls in one turn
          for (let i = 1; i <= 70; i++) {
            const res = await httpPostUnix(mcpSock, mcpToken, {
              method: 'tools/call',
              params: { name: 'workspace_read_file', arguments: { path: `f-${i}.js`, offset: 0, length: 10 } },
            });
            assert.equal(res.body.result.isError, false);
          }
          send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Completed 70 reads.' } } } });
          send({ id: m.id, result: { stopReason: 'end_turn' } });
          return;
        }
        // Run 2: identical failure loop guard + consecutive failure circuit breaker
        failCommands = true;
        // 2 identical failing commands -> 3rd identical blocked by loop guard (doesn't burn breaker)
        for (let i = 0; i < 3; i++) {
          const r = await httpPostUnix(mcpSock, mcpToken, {
            method: 'tools/call',
            params: { name: 'workspace_run', arguments: { command: 'exit 1' } },
          });
          breakerResults.push(r.body.result.content[0].text);
        }
        // 3rd distinct failing command -> hits maxConsecutiveFailures=3 -> trips circuit breaker
        const r4 = await httpPostUnix(mcpSock, mcpToken, {
          method: 'tools/call',
          params: { name: 'workspace_run', arguments: { command: 'exit 2' } },
        });
        breakerResults.push(r4.body.result.content[0].text);
        // 5th call (even a read!) is blocked by tripped circuit breaker
        const r5 = await httpPostUnix(mcpSock, mcpToken, {
          method: 'tools/call',
          params: { name: 'workspace_read_file', arguments: { path: 'any.js', offset: 0, length: 5 } },
        });
        breakerResults.push(r5.body.result.content[0].text);

        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Paused due to repeated failures.' } } } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
    });
  });
  await new Promise(resolve => agyServer.listen(agySocket, resolve));
  t.after(() => agyServer.close());

  const makeTurn = (sessionId, text) => {
    const turnId = randomUUID();
    const turn = {
      id: turnId, sessionId, workspaceId: wsId, createdAt: Date.now(),
      state: 'preparing', done: false, consumed: false, engine: 'antigravity',
      text, attachments: [], calls: [], historyBefore: 0,
      binding: { accountId: '1', deviceId, workspaceId: wsId, grantVersion: 1, sessionId, turnId, turnEpoch: 1 },
    };
    store.tx(() => {
      store.append(sessionId, { type: 'user_message', text });
      store.put('sessions', sessionId, { ...store.session(sessionId), activeTurnId: turnId });
      store.put('turns', turnId, turn);
    });
    return turn;
  };

  // Run 1: 70 reads
  const agyDefault = new AntigravityTurns(host, agySocket, dir, { mcpDir: dir });
  const s1 = store.create({ requestId: randomUUID(), workspaceId: wsId, title: 'AGY 70 reads' }, grant);
  await agyDefault.run(makeTurn(s1.id, 'Read 70 files'));

  assert.equal(stats.issueCalls, 70);
  assert.equal(stats.recoverCalls, 0);
  assert.equal(store.all('agyResults').length, 0);
  const s1End = store.pageBefore(s1.id, 9999).events.find(r => r.event.type === 'turn_end')?.event;
  assert.deepEqual(s1End.toolCalls, { total: 70, mutations: 0 });

  // Run 2: loop guard + consecutive failure breaker
  const agyBreaker = new AntigravityTurns(host, agySocket, dir, {
    mcpDir: dir,
    toolBudget: { maxTotalCalls: 20, maxMutationCalls: 20, maxConsecutiveFailures: 3, maxConsecutiveIdenticalFailures: 2 },
  });
  const s2 = store.create({ requestId: randomUUID(), workspaceId: wsId, title: 'AGY breaker' }, grant);
  await agyBreaker.run(makeTurn(s2.id, 'Run failing cmds'));

  assert.match(breakerResults[0], /failed:workspace_run/);
  assert.match(breakerResults[1], /failed:workspace_run/);
  assert.match(breakerResults[2], /Repeated identical failing call blocked/);
  assert.match(breakerResults[3], /Consecutive tool failure limit reached/);
  assert.match(breakerResults[4], /Circuit breaker tripped/);
  const s2Events = store.page(s2.id, 0).events.map(r => r.event);
  const notices = s2Events.filter(e => e.type === 'turn_notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].code, 'consecutive_failures');
  assert.equal(notices[0].canContinue, true);

  // Run 3: Crash reconcile skips consumed rows and recovers only unconsumed + legacy calls
  const s3 = store.create({ requestId: randomUUID(), workspaceId: wsId, title: 'Crash reconcile' }, grant);
  const crashTurnId = randomUUID();
  opsByCallId.set('c-pending', { callId: 'c-pending', operationId: 'op-crash-1', toolName: 'workspace_read_file', args: { path: 'a.js' } });
  opsById.set('op-crash-1', opsByCallId.get('c-pending'));
  const crashTurn = {
    id: crashTurnId, sessionId: s3.id, workspaceId: wsId, createdAt: Date.now(),
    state: 'running', done: false, consumed: false, engine: 'antigravity',
    text: 'crashed', attachments: [],
    calls: [{ id: 'legacy-unsubmitted', tool: 'workspace_read_file', args: { path: 'old.js' }, inputHash: 'h-leg' }],
    historyBefore: 0,
    binding: { accountId: '1', deviceId, workspaceId: wsId, grantVersion: 1, sessionId: s3.id, turnId: crashTurnId, turnEpoch: 1 },
  };
  store.tx(() => {
    store.append(s3.id, { type: 'user_message', text: 'crashed' });
    store.put('sessions', s3.id, { ...store.session(s3.id), activeTurnId: crashTurnId });
    store.put('turns', crashTurnId, crashTurn);
    store.upsertTurnCall({
      turnId: crashTurnId, sessionId: s3.id, callId: 'c-already-done',
      tool: 'workspace_read_file', effectiveTool: 'workspace_read_file', inputHash: 'h1',
      argsSummary: { path: 'done.js' }, operationId: 'op-done', state: 'completed', ok: true, consumed: true, counted: true,
    });
    store.upsertTurnCall({
      turnId: crashTurnId, sessionId: s3.id, callId: 'c-pending',
      tool: 'workspace_read_file', effectiveTool: 'workspace_read_file', inputHash: 'h2',
      argsSummary: { path: 'a.js' }, operationId: 'op-crash-1', state: 'dispatched', ok: null, consumed: false, counted: true,
    });
  });

  const recoverBefore = stats.recoverCalls;
  await agyDefault.reconcile(store.get('turns', crashTurnId));
  // Only c-pending + legacy-unsubmitted should be recovered (NOT c-already-done!)
  assert.equal(stats.recoverCalls - recoverBefore, 2);
  assert.equal(store.getTurnCall(crashTurnId, 'c-pending').consumed, true);
  assert.equal(store.get('turns', crashTurnId).consumed, true);
  const s3Events = store.page(s3.id, 0).events.map(r => r.event);
  assert.ok(s3Events.some(e => e.type === 'tool_call' && e.id === 'c-pending' && e.status === 'completed'));
  assert.ok(s3Events.some(e => e.type === 'tool_call' && e.id === 'legacy-unsubmitted' && e.output === '未提交到设备。'));
});
