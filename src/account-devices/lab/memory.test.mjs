import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { SessionStore } from '../../session-host/store.mjs';
import {
  MEMORY_LIMITS,
  PROJECT_DOC_CANDIDATES,
  buildMemoryInstructions,
  executeMemoryTool,
  extractProjectDocsFromReadResult,
} from '../../session-host/memory.mjs';
import { CodexTurns } from '../../session-host/codex-turns.mjs';
import { AntigravityTurns } from '../../session-host/antigravity-turns.mjs';
import { grantFor } from '../../execution/grants.mjs';
import { hash } from '../../execution/protocol.mjs';
import { WorkspaceExecutor } from '../../workspace/executor.mjs';
import { linuxWorkspace } from '../linux-workspace.mjs';
import contract from '../contract.cjs';

function httpPostUnix(socketPath, token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      socketPath,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: 'Bearer ' + token,
      },
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('SessionStore enforces project & account memory limits, isolation, upsert and purge', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-mem-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, 'history.sqlite'));
  t.after(() => store.close());

  const wsA = randomUUID();
  const wsB = randomUUID();

  // Upsert & in-place update for workspace A
  const s1 = store.upsertMemory('workspace', wsA, { key: '  deploy\nstep  ', content: 'Run bash deploy.sh' });
  assert.equal(s1.item.key, 'deploy step');
  assert.equal(s1.count, 1);
  assert.equal(s1.limits.maxItems, 30);
  assert.equal(s1.limits.maxTotalBytes, 8192);

  const s1Update = store.upsertMemory('workspace', wsA, { key: 'deploy step', content: 'Run pnpm run deploy' });
  assert.equal(s1Update.count, 1);
  assert.equal(store.listMemories('workspace', wsA).items[0].content, 'Run pnpm run deploy');

  // Workspace isolation
  store.upsertMemory('workspace', wsB, { key: 'stack', content: 'Python FastAPI' });
  assert.equal(store.listMemories('workspace', wsA).count, 1);
  assert.equal(store.listMemories('workspace', wsB).count, 1);
  assert.equal(store.listMemories('workspace', wsB).items[0].content, 'Python FastAPI');

  // Single-entry length limits
  assert.throws(() => store.upsertMemory('workspace', wsA, { key: 'too-long', content: 'a'.repeat(501) }), /MEMORY_TOO_LARGE/);
  assert.throws(() => store.upsertMemory('user', null, { key: 'too-long', content: 'b'.repeat(301) }), /MEMORY_TOO_LARGE/);

  // Account global memory limits: max 10 items, max 2048 bytes
  for (let i = 0; i < 10; i++) {
    store.upsertMemory('user', null, { key: `pref-${i}`, content: `rule-${i}` });
  }
  assert.equal(store.listMemories('user', null).count, 10);
  assert.throws(() => store.upsertMemory('user', null, { key: 'pref-10', content: 'overflow' }), /MEMORY_LIMIT_REACHED/);
  // Updating an existing key at maxItems succeeds
  store.upsertMemory('user', null, { key: 'pref-0', content: 'updated-rule-0' });
  assert.equal(store.listMemories('user', null).items.find(x => x.key === 'pref-0')?.content, 'updated-rule-0');

  // Global byte cap (2048 bytes)
  store.clearMemories('user', null);
  for (let i = 0; i < 6; i++) {
    store.upsertMemory('user', null, { key: `k${i}`, content: 'x'.repeat(290) }); // 6 * 292 = 1752 bytes
  }
  assert.throws(() => store.upsertMemory('user', null, { key: 'k6', content: 'x'.repeat(298) }), /MEMORY_STORAGE_LIMIT/);

  // Workspace item cap (30) and byte cap (8192)
  store.clearMemories('workspace', wsA);
  for (let i = 0; i < 30; i++) {
    store.upsertMemory('workspace', wsA, { key: `w${i}`, content: `val-${i}` });
  }
  assert.throws(() => store.upsertMemory('workspace', wsA, { key: 'w30', content: 'overflow' }), /MEMORY_LIMIT_REACHED/);
  store.clearMemories('workspace', wsA);
  for (let i = 0; i < 16; i++) {
    store.upsertMemory('workspace', wsA, { key: `b${i}`, content: 'y'.repeat(498) }); // 16 * ~500 = ~8000 bytes
  }
  assert.throws(() => store.upsertMemory('workspace', wsA, { key: 'b16', content: 'y'.repeat(300) }), /MEMORY_STORAGE_LIMIT/);

  // Purge removes only target workspace, leaving wsB & user intact
  const purged = store.purgeWorkspaceMemories(wsA);
  assert.equal(purged, 16);
  assert.equal(store.listMemories('workspace', wsA).count, 0);
  assert.equal(store.listMemories('workspace', wsB).count, 1);
  assert.equal(store.listMemories('user', null).count, 6);

  // Prompt formatting truncation and tool execution
  store.clearMemories('user', null);
  const saveRes = executeMemoryTool(store, wsA, 'memory_save', { key: 'build', content: 'npm run build' });
  assert.equal(saveRes.ok, true);
  assert.match(saveRes.text, /Saved project memory "build"/);
  const userSaveRes = executeMemoryTool(store, wsA, 'memory_save', { scope: 'user', key: 'lang', content: '中文回复' });
  assert.equal(userSaveRes.ok, true);
  const listRes = executeMemoryTool(store, wsA, 'memory_list', {});
  assert.equal(listRes.ok, true);
  assert.match(listRes.text, /npm run build/);
  assert.match(listRes.text, /中文回复/);
  const prompt = buildMemoryInstructions({
    store,
    workspaceId: wsA,
    projectLabel: 'demo-repo',
    projectDocs: [{ path: 'AGENTS.md', text: 'Always run tests before commit.', truncated: false }],
  });
  assert.match(prompt, /\[Project Memories: demo-repo\]/);
  assert.match(prompt, /- build: npm run build/);
  assert.match(prompt, /\[Account Global Preferences\]/);
  assert.match(prompt, /- lang: 中文回复/);
  assert.match(prompt, /### AGENTS\.md\nAlways run tests before commit\./);

  const delRes = executeMemoryTool(store, wsA, 'memory_delete', { key: 'build' });
  assert.equal(delRes.ok, true);
  assert.match(delRes.text, /Deleted project memory "build"/);
  assert.equal(store.listMemories('workspace', wsA).count, 0);
});

test('extractProjectDocsFromReadResult parses Linux & Windows read_multiple_files outputs and skips missing files', () => {
  const rev = 'file-v1:' + 'a'.repeat(64);
  // Linux format
  const linuxResult = {
    content: [
      { type: 'text', text: `1\t# Agents\n2\tUse pnpm\n--- AGENTS.md (lines 1-2 of 2, revision: ${rev}) ---` },
      { type: 'text', text: 'Error reading CLAUDE.md: FILE_NOT_FOUND' },
      { type: 'text', text: `1\tGemini rule\n--- GEMINI.md (lines 1-1 of 1, revision: ${rev}) ---` },
    ],
    structuredContent: {
      result: {
        fileVersions: [
          { path: 'AGENTS.md', revision: rev, size: 18 },
          { path: 'GEMINI.md', revision: rev, size: 11 },
        ],
      },
    },
  };
  const parsedLinux = extractProjectDocsFromReadResult(PROJECT_DOC_CANDIDATES, linuxResult);
  assert.equal(parsedLinux.docs.length, 2);
  assert.equal(parsedLinux.docs[0].path, 'AGENTS.md');
  assert.equal(parsedLinux.docs[0].text, '# Agents\nUse pnpm');
  assert.equal(parsedLinux.docs[1].path, 'GEMINI.md');
  assert.equal(parsedLinux.docs[1].text, 'Gemini rule');

  // Windows format
  const winResult = {
    content: [
      { type: 'text', text: 'AGENTS.md: FILE_NOT_FOUND' },
      { type: 'text', text: 'CLAUDE.md\n1\tNever force push\n2\tKeep PRs small' },
      { type: 'text', text: 'GEMINI.md: FILE_NOT_FOUND' },
      { type: 'text', text: `File versions (expectedRevision): [{"path":"CLAUDE.md","revision":"${rev}","size":32}]` },
    ],
    structuredContent: {
      result: {
        fileVersions: [{ path: 'CLAUDE.md', revision: rev, size: 32 }],
      },
    },
  };
  const parsedWin = extractProjectDocsFromReadResult(PROJECT_DOC_CANDIDATES, winResult);
  assert.equal(parsedWin.docs.length, 1);
  assert.equal(parsedWin.docs[0].path, 'CLAUDE.md');
  assert.equal(parsedWin.docs[0].text, 'Never force push\nKeep PRs small');
});

test('desktop contract strictly validates memory IPC routes', () => {
  const wsId = randomUUID();
  contract.validate('memoriesList', { scope: 'workspace', workspaceId: wsId });
  contract.validate('memoriesList', { scope: 'user' });
  contract.validate('memoriesSave', { scope: 'workspace', workspaceId: wsId, key: 'deploy', content: 'x'.repeat(500) });
  contract.validate('memoriesSave', { scope: 'user', key: 'lang', content: 'y'.repeat(300) });
  contract.validate('memoriesDelete', { scope: 'workspace', workspaceId: wsId, key: 'deploy' });
  contract.validate('memoriesDelete', { scope: 'user', key: 'lang' });
  contract.validate('memoriesClear', { scope: 'workspace', workspaceId: wsId });
  contract.validate('memoriesClear', { scope: 'user' });

  assert.throws(() => contract.validate('memoriesList', { scope: 'invalid' }), /INVALID_MEMORY_SCOPE/);
  assert.throws(() => contract.validate('memoriesList', { scope: 'workspace' }), /INVALID_ID/);
  assert.throws(() => contract.validate('memoriesList', { scope: 'user', workspaceId: wsId }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('memoriesSave', { scope: 'user', key: 'lang', content: 'y'.repeat(301) }), /MEMORY_TOO_LARGE/);
  assert.throws(() => contract.validate('memoriesSave', { scope: 'workspace', workspaceId: wsId, key: 'k', content: 'x'.repeat(501) }), /MEMORY_TOO_LARGE/);
  assert.throws(() => contract.validate('memoriesSave', { scope: 'user', key: '   ', content: 'ok' }), /INVALID_TEXT/);
});

test('end-to-end cross-session & cross-engine memory (Codex <-> Antigravity) with read-only AGENTS.md preload', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-mem-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const projectDir = join(dir, 'my-repo');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'AGENTS.md'), '# Project Rules\nUse pnpm test for verification.\n');
  writeFileSync(join(projectDir, 'CLAUDE.md'), 'Always update changelog on release.\n');

  const store = new SessionStore(join(dir, 'history.sqlite'));
  t.after(() => store.close());

  const wsId = randomUUID();
  const deviceId = randomUUID();
  // Read-only grant! Memory tools MUST work even without workspace.write permission!
  const grant = grantFor({ accountId: '1', deviceId, workspaceId: wsId }, 'read', 1);
  const linux = linuxWorkspace();
  const rootIdentity = linux.identifyRoot(projectDir);
  const launchOp = linux.launcher({ workspaceRoot: projectDir, rootIdentity, stateDir: dir, readOnly: true });

  // Minimal in-memory broker stub exercising real WorkspaceExecutor + real linuxWorkspace read_multiple_files
  const ops = new Map();
  const callsByKey = new Map();
  const brokerControl = async (method, params = {}) => {
    if (method === 'workspace') {
      return {
        label: 'my-repo',
        phase: 'ready',
        confirmed: true,
        grant,
        blockers: [],
        activeOperations: [],
        sandbox: linux.sandbox,
      };
    }
    if (method === 'lookupCall') {
      const k = `${params.sessionId}:${params.turnId}:${params.turnEpoch}:${params.toolCallId}`;
      return callsByKey.get(k) ?? null;
    }
    if (method === 'prepare') {
      const opId = randomUUID();
      const request = {
        scope: {
          accountId: grant.accountId,
          deviceId: grant.deviceId,
          workspaceId: grant.workspaceId,
          grantVersion: grant.grantVersion,
          sessionId: params.sessionId,
          turnId: params.turnId,
          turnEpoch: params.turnEpoch,
        },
        toolCallId: params.toolCallId,
        kind: params.kind,
        cwdRelative: params.cwdRelative,
        args: params.args,
        expiresAt: params.expiresAt,
      };
      const op = {
        operationId: opId,
        taskId: opId,
        state: 'prepared',
        request,
        requestHash: hash(request),
        lastSeq: 0,
        receivedSeq: 0,
        gaps: [],
      };
      ops.set(opId, op);
      const k = `${params.sessionId}:${params.turnId}:${params.turnEpoch}:${params.toolCallId}`;
      callsByKey.set(k, op);
      return op;
    }
    if (method === 'dispatch') {
      const op = ops.get(params.operationId);
      const runner = launchOp(op, grant);
      const res = await runner.read();
      op.state = 'succeeded';
      op.result = { tool: res };
      op.resultDigest = hash(op.result);
      return op;
    }
    if (method === 'operation') return ops.get(params.operationId);
    if (method === 'output') return { rows: [], nextSeq: 0, truncatedThrough: 0, firstAvailableSeq: 1, more: false };
    if (method === 'ackResult') return { ok: true };
    if (method === 'stopTurn' || method === 'reasoningIdle') return { ok: true };
    throw Error(`UNEXPECTED_BROKER_${method}`);
  };

  // Minimal host harness matching SessionHost interface used by CodexTurns & AntigravityTurns
  const workspaceEntry = { id: wsId, label: 'my-repo', grant };
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
    closeHost: async () => {},
    async preloadProjectDocs(turn) {
      const executor = new WorkspaceExecutor({ journal: store, binding: turn.binding, control: (m, p) => brokerControl(m, p) });
      const args = { paths: [...PROJECT_DOC_CANDIDATES] };
      const ticket = await executor.issue('preload-docs:' + turn.id, 'workspace_read_files', args, { expiresAt: Date.now() + 15000 });
      const result = await executor.invoke('workspace_read_files', args, ticket.ticket, { waitMs: 6000 });
      const task = result.structuredContent.task;
      const { docs, fileVersions } = extractProjectDocsFromReadResult(PROJECT_DOC_CANDIDATES, result);
      for (const v of fileVersions) {
        store.put('revisions', hash({ sessionId: turn.sessionId, workspaceId: turn.workspaceId, path: v.path }), v);
      }
      await executor.consumeAfterPersist({ operationId: ticket.operationId, resultDigest: task.resultDigest, receiptId: 'preload-docs:' + ticket.operationId });
      return docs;
    },
  };

  // 1. Mock Codex server: verifies AGENTS.md/CLAUDE.md preload and saves both project & user memories
  const codexSocket = join(dir, 'codex.sock');
  const codexCaptured = [];
  let codexRunCount = 0;
  const codexServer = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => { if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n'); };
    let threadId = null, turnId = null, toolStep = 0;
    const runIndex = ++codexRunCount;
    rl.on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
      if (m.method === 'thread/start') {
        threadId = 'codex-thread-' + runIndex;
        codexCaptured.push({
          runIndex,
          developerInstructions: m.params.developerInstructions,
          toolNames: (m.params.dynamicTools ?? []).map(x => x.name),
        });
        send({ id: m.id, result: { thread: { id: threadId }, model: 'gpt-5.4' } });
        return;
      }
      if (m.method === 'turn/start') {
        turnId = 'codex-turn-' + runIndex;
        send({ id: m.id, result: { turn: { id: turnId } } });
        if (runIndex === 1) {
          toolStep = 1;
          send({
            id: 101,
            method: 'item/tool/call',
            params: {
              threadId,
              turnId,
              callId: 'mem-call-1',
              tool: 'memory_save',
              arguments: { key: 'deploy', content: 'Deploy with bash scripts/deploy-prod.sh' },
            },
          });
        } else {
          send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'm-' + runIndex, type: 'agentMessage', text: 'Checked memories.' } } });
          send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', durationMs: 10 } } });
        }
        return;
      }
      if (m.id === 101 && toolStep === 1) {
        assert.equal(m.result.success, true);
        toolStep = 2;
        send({
          id: 102,
          method: 'item/tool/call',
          params: {
            threadId,
            turnId,
            callId: 'mem-call-2',
            tool: 'memory_save',
            arguments: { scope: 'user', key: 'reply-lang', content: 'Always reply in concise Chinese.' },
          },
        });
        return;
      }
      if (m.id === 102 && toolStep === 2) {
        assert.equal(m.result.success, true);
        send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'm-1', type: 'agentMessage', text: 'Saved both memories.' } } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', durationMs: 15 } } });
      }
    });
  });
  await new Promise(resolve => codexServer.listen(codexSocket, resolve));
  t.after(() => codexServer.close());

  // 2. Mock Antigravity ACP server: verifies memory from Codex session 1 is auto-injected into a BRAND-NEW session,
  // verifies permission whitelist allows mcp_anywhere_workspace_memory_*, lists and deletes project memory via MCP bridge!
  const agySocket = join(dir, 'agy.sock');
  const agyCaptured = {};
  const agyServer = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => { if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n'); };
    let sessionId = null;
    let mcpSock = null, mcpToken = null;
    let promptReqId = null;
    rl.on('line', async line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') { send({ id: m.id, result: { protocolVersion: 1 } }); return; }
      if (m.method === 'session/new') {
        sessionId = 'agy-sess-1';
        agyCaptured.systemPromptAppend = m.params?._meta?.antigravity?.systemPrompt?.append ?? '';
        const srv = m.params?.mcpServers?.[0];
        const envMap = Object.fromEntries((srv?.env ?? []).map(e => [e.name, e.value]));
        mcpSock = envMap.ANYWHERE_MCP_SOCKET;
        mcpToken = envMap.ANYWHERE_MCP_TOKEN;
        send({ id: m.id, result: { sessionId, models: { currentModelId: 'gemini-4-neon-high', availableModels: [] } } });
        return;
      }
      if (m.method === 'session/prompt') {
        promptReqId = m.id;
        // Request ACP permission for mcp_anywhere_workspace_memory_list
        send({
          id: 501,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { name: 'mcp_anywhere_workspace_memory_list' },
            options: [
              { kind: 'allow_once', optionId: 'allow-1' },
              { kind: 'reject_once', optionId: 'reject-1' },
            ],
          },
        });
        return;
      }
      if (m.id === 501) {
        agyCaptured.permissionOutcome = m.result?.outcome;
        // Call tools/list, memory_list, and memory_delete directly against the live MCP bridge socket!
        const listedTools = await httpPostUnix(mcpSock, mcpToken, { method: 'tools/list' });
        agyCaptured.mcpToolNames = listedTools.body?.result?.tools?.map(x => x.name) ?? [];
        const memList = await httpPostUnix(mcpSock, mcpToken, {
          method: 'tools/call',
          params: { name: 'memory_list', arguments: { scope: 'all' } },
        });
        agyCaptured.memoryListText = memList.body?.result?.content?.[0]?.text ?? '';
        const memDel = await httpPostUnix(mcpSock, mcpToken, {
          method: 'tools/call',
          params: { name: 'memory_delete', arguments: { scope: 'workspace', key: 'deploy' } },
        });
        agyCaptured.memoryDeleteText = memDel.body?.result?.content?.[0]?.text ?? '';
        send({
          method: 'session/update',
          params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Updated project memories.' } } },
        });
        send({ id: promptReqId, result: { stopReason: 'end_turn' } });
      }
    });
  });
  await new Promise(resolve => agyServer.listen(agySocket, resolve));
  t.after(() => agyServer.close());

  const codex = new CodexTurns(host, codexSocket, dir);
  const agy = new AntigravityTurns(host, agySocket, dir, { mcpDir: dir });

  const runTurn = async (engine, title, text) => {
    const s = store.create({ requestId: randomUUID(), workspaceId: wsId, title, options: { agent: engine } }, grant);
    const turnId = randomUUID();
    const turn = {
      id: turnId,
      sessionId: s.id,
      workspaceId: wsId,
      createdAt: Date.now(),
      state: 'preparing',
      done: false,
      consumed: false,
      engine,
      text,
      attachments: [],
      calls: [],
      historyBefore: 0,
      binding: { accountId: grant.accountId, deviceId, workspaceId: wsId, grantVersion: grant.grantVersion, sessionId: s.id, turnId, turnEpoch: 1 },
    };
    store.tx(() => {
      store.append(s.id, { type: 'user_message', text });
      store.put('sessions', s.id, { ...store.session(s.id), activeTurnId: turnId });
      store.put('turns', turnId, turn);
    });
    if (engine === 'codex') await codex.run(turn);
    else await agy.run(turn);
    return s;
  };

  // Session 1 (Codex, read-only): loads AGENTS.md + CLAUDE.md, saves project & user memory
  const s1 = await runTurn('codex', 'Session 1', '记住这个项目的部署脚本，另外以后一律用简洁中文回复');
  assert.equal(codexCaptured.length, 1);
  assert.ok(codexCaptured[0].toolNames.includes('memory_save'));
  assert.ok(codexCaptured[0].toolNames.includes('memory_list'));
  assert.ok(codexCaptured[0].toolNames.includes('memory_delete'));
  assert.match(codexCaptured[0].developerInstructions, /### AGENTS\.md\n# Project Rules\nUse pnpm test for verification\./);
  assert.match(codexCaptured[0].developerInstructions, /### CLAUDE\.md\nAlways update changelog on release\./);
  const s1Events = store.page(s1.id, 0).events.map(e => e.event);
  assert.ok(s1Events.some(e => e.type === 'tool_call' && e.name === 'memory_save' && e.status === 'completed'));

  // Session 2 (BRAND-NEW session on Antigravity): automatically receives both memories + root docs, deletes 'deploy'
  const s2 = await runTurn('antigravity', 'Session 2', '检查并删除旧的 deploy 记忆');
  assert.match(agyCaptured.systemPromptAppend, /\[Project Memories: my-repo\]/);
  assert.match(agyCaptured.systemPromptAppend, /- deploy: Deploy with bash scripts\/deploy-prod\.sh/);
  assert.match(agyCaptured.systemPromptAppend, /\[Account Global Preferences\]/);
  assert.match(agyCaptured.systemPromptAppend, /- reply-lang: Always reply in concise Chinese\./);
  assert.match(agyCaptured.systemPromptAppend, /### AGENTS\.md/);
  assert.deepEqual(agyCaptured.permissionOutcome, { outcome: 'selected', optionId: 'allow-1' });
  assert.ok(agyCaptured.mcpToolNames.includes('memory_save'));
  assert.ok(agyCaptured.mcpToolNames.includes('memory_list'));
  assert.ok(agyCaptured.mcpToolNames.includes('memory_delete'));
  assert.match(agyCaptured.memoryListText, /deploy-prod\.sh/);
  assert.match(agyCaptured.memoryDeleteText, /Deleted project memory "deploy"/);
  const s2Events = store.page(s2.id, 0).events.map(e => e.event);
  assert.ok(s2Events.some(e => e.type === 'tool_call' && e.name === 'memory_delete' && e.status === 'completed'));

  // Session 3 (BRAND-NEW session back on Codex): 'deploy' is gone, global preference remains!
  await runTurn('codex', 'Session 3', '你好');
  assert.equal(codexCaptured.length, 2);
  assert.doesNotMatch(codexCaptured[1].developerInstructions, /deploy-prod\.sh/);
  assert.match(codexCaptured[1].developerInstructions, /- reply-lang: Always reply in concise Chinese\./);
});
