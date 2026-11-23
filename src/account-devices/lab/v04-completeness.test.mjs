import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { parsePatch, applyHunks } from '../../workspace/patch.mjs';
import { normalize } from '../../workspace/catalog.mjs';
import { hash } from '../../execution/protocol.mjs';
import contract from '../contract.cjs';

test('patch parser/applier and expanded workspace tool catalog enforce boundaries and large writes', () => {
  const ops = parsePatch([
    '*** Begin Patch',
    '*** Add File: src/new.js',
    '+export const x = 1;',
    '*** Update File: src/app.js',
    '*** Move to: src/main.js',
    '@@ function init()',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '*** Delete File: old.txt',
    '*** End Patch',
  ].join('\n'));
  assert.equal(ops.length, 3);
  assert.equal(ops[0].kind, 'add');
  assert.equal(ops[1].moveTo, 'src/main.js');
  assert.equal(ops[2].kind, 'delete');

  const updated = applyHunks('function init()\r\nconst a = 1;\r\nconst b = 2;\r\n', ops[1].hunks, 'src/app.js');
  assert.equal(updated, 'function init()\r\nconst a = 1;\r\nconst b = 3;\r\n');
  assert.throws(() => applyHunks('unrelated\n', ops[1].hunks, 'src/app.js'), /PATCH_HUNK_MISMATCH/);

  const rev = 'file-v1:' + 'a'.repeat(64);
  const bigWrite = normalize('workspace_write_file', {
    path: 'src/big.js', content: 'x'.repeat(65536), mode: 'rewrite', expectedRevision: null,
  });
  assert.equal(bigWrite.args.arguments.content.length, 65536);

  const read500 = normalize('workspace_read_file', { path: 'src/big.js', offset: 0, length: 500 });
  assert.equal(read500.args.arguments.length, 500);
  assert.throws(() => normalize('workspace_read_file', { path: 'src/big.js', offset: 0, length: 501 }), /INVALID_INTEGER/);

  normalize('workspace_delete_file', { path: 'old.txt', expectedRevision: rev });
  assert.throws(() => normalize('workspace_delete_file', { path: '../escape.txt', expectedRevision: rev }), /PATH_DENIED/);

  normalize('workspace_move_file', { fromPath: 'a.txt', toPath: 'b/c.txt', expectedFromRevision: rev, expectedToRevision: null });
  assert.throws(() => normalize('workspace_move_file', { fromPath: 'a.txt', toPath: '../b.txt', expectedFromRevision: rev, expectedToRevision: null }), /PATH_DENIED/);

  normalize('workspace_apply_patch', {
    patch: '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch',
    expectedRevisions: { 'a.txt': null },
  });
  assert.throws(() => normalize('workspace_apply_patch', {
    patch: '*** Begin Patch\n*** Add File: ../a.txt\n+hi\n*** End Patch',
    expectedRevisions: { '../a.txt': null },
  }), /PATH_DENIED/);
});

test('desktop contract validates all v0.4.0 routes and optional parameters strictly', () => {
  const id = randomUUID();
  contract.validate('renameSession', { sessionId: id, title: '新标题' });
  contract.validate('deleteSession', { sessionId: id });
  contract.validate('setSessionOptions', { sessionId: id, agent: 'antigravity', model: 'gemini-4-neon', effort: 'high' });
  contract.validate('setSessionOptions', { sessionId: id, model: 'gpt-5.4', effort: 'high' });
  contract.validate('setSessionOptions', { sessionId: id, model: null, agent: null });
  assert.throws(() => contract.validate('setSessionOptions', { sessionId: id, agent: 'unknown-cli' }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('setSessionOptions', { sessionId: id, effort: 'turbo' }), /INVALID_FIELDS/);
  contract.validate('send', { sessionId: id, requestId: id, text: 'a'.repeat(40000) });
  contract.validate('send', { sessionId: id, requestId: id, text: '看附件', attachments: [id] });
  assert.throws(() => contract.validate('send', { sessionId: id, requestId: id, text: 'x', attachments: ['not-a-uuid'] }), /INVALID_ID/);
  contract.validate('create', { workspaceId: id, requestId: id, title: 'T', options: { agent: 'antigravity', model: 'gemini-4-neon', effort: 'medium' } });
  contract.validate('reviewList', { workspaceId: id });
  contract.validate('reviewSubmit', { workspaceId: id, requestId: id, operationId: id, expectedDigest: 'b'.repeat(64), note: '已检查本地文件' });
  contract.validate('subscribe', { sessionId: id, afterSeq: 0 });
  contract.validate('unsubscribe', {});
  contract.validate('historyBefore', { sessionId: id, beforeSeq: 10 });
  contract.validate('removeWorkspace', { workspaceId: id });
  contract.validate('chooseAttachment', { sessionId: id });
  assert.throws(() => contract.validate('uploadAttachmentFile', { sessionId: id, path: '/tmp/a' }), /INVALID_FIELDS/);
  contract.internalValidate('uploadAttachmentFile', { sessionId: id, path: '/tmp/a' });
});

test('end-to-end v0.4.0: streaming deltas, model/effort, attachments, session CRUD, workspace removal and unknown review', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-v04-'));
  const authDir = join(dir, 'auth');
  const hostState = join(dir, 'host');
  const clientState = join(dir, 'client');
  const projectA = join(dir, 'project-a');
  const projectB = join(dir, 'project-b');
  mkdirSync(authDir, { recursive: true });
  mkdirSync(hostState, { recursive: true });
  mkdirSync(clientState, { recursive: true });
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(join(projectA, 'notes.txt'), 'hello v0.4\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Generate a self-signed TLS cert for 127.0.0.1
  const keyPath = join(dir, 'server.key');
  const certPath = join(dir, 'server.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });

  // Mock Codex app-server over Unix socket that verifies model/effort/localImage, streams deltas, and invokes session_read_attachment.
  const codexSocket = join(dir, 'codex.sock');
  const observed = { turnStart: null, attachmentToolReply: null };
  const codexServer = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    let pendingCall = null;
    const send = obj => sock.write(JSON.stringify(obj) + '\n');
    rl.on('line', line => {
      const m = JSON.parse(line);
      if (m.id !== undefined && m.result !== undefined && pendingCall && m.id === pendingCall.id) {
        observed.attachmentToolReply = m.result;
        const finish = pendingCall.done;
        pendingCall = null;
        finish();
        return;
      }
      if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
      if (m.method === 'model/list') {
        send({ id: m.id, result: { data: [{ id: 'gpt-5.4', displayName: 'GPT-5.4', supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', isDefault: true }] } });
        return;
      }
      if (m.method === 'thread/start' || m.method === 'thread/resume') {
        send({ id: m.id, result: { thread: { id: m.params.threadId ?? 'thread-v04' }, model: m.params.model ?? 'gpt-5.4' } });
        return;
      }
      if (m.method === 'turn/start') {
        observed.turnStart = m.params;
        const turnId = 'turn-' + randomUUID().slice(0, 8);
        send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } });
        const threadId = m.params.threadId;
        setTimeout(() => {
          send({ method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId, itemId: 'r1', delta: '正在分析附件…' } });
          send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'r1', type: 'reasoning', summary: ['正在分析附件…'] } } });
          // Ask host to execute session_read_attachment
          pendingCall = {
            id: 'srv-call-1',
            done: () => {
              send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'm1', delta: '已收到' } });
              send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'm1', delta: '流式回复！' } });
              send({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { last: { totalTokens: 320, inputTokens: 200, outputTokens: 120, cachedInputTokens: 50 }, modelContextWindow: 200000 } } });
              send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'm1', type: 'agentMessage', text: '已收到流式回复！' } } });
              send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', durationMs: 420 } } });
            },
          };
          send({ id: 'srv-call-1', method: 'item/tool/call', params: { threadId, turnId, callId: 'call-att-1', tool: 'session_read_attachment', arguments: { attachment: 'spec.txt' } } });
        }, 25);
      }
    });
  });
  await new Promise(resolve => codexServer.listen(codexSocket, resolve));
  t.after(() => codexServer.close());

  // Mock Antigravity ACP server over Unix socket that spawns the real agy-mcp-bridge.mjs,
  // verifies strict built-in tool rejection, calls MCP workspace_read_file + session_read_attachment,
  // and streams thought/message chunks.
  const agySocket = join(dir, 'agy.sock');
  const agyObserved = { configs: [], builtinDecision: null, mcpDecision: null, promptBlocks: null, discoverCode: null, wsReadOk: false, attReadText: '' };
  const agyServer = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => sock.write(JSON.stringify(obj) + '\n');
    const pendingClient = new Map();
    let clientReqId = 100;
    const askClient = (method, params) => new Promise((resolve, reject) => {
      const id = ++clientReqId;
      pendingClient.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
    });
    let mcpProc = null;
    let mcpPending = new Map();
    let mcpNextId = 1;
    const mcpCall = (method, params) => new Promise((resolve, reject) => {
      const id = ++mcpNextId;
      mcpPending.set(id, { resolve, reject });
      mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    sock.on('close', () => { try { mcpProc?.kill(); } catch {} });
    rl.on('line', async line => {
      const m = JSON.parse(line);
      if (m.id !== undefined && !m.method && pendingClient.has(m.id)) {
        const w = pendingClient.get(m.id);
        pendingClient.delete(m.id);
        if (m.error) w.reject(Error(m.error.message)); else w.resolve(m.result);
        return;
      }
      if (m.method === 'initialize') {
        send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
        return;
      }
      if (m.method === 'session/new') {
        const mcpDef = m.params?.mcpServers?.[0];
        if (mcpDef) {
          const env = { ...process.env };
          for (const e of mcpDef.env ?? []) env[e.name] = e.value;
          mcpProc = spawn(mcpDef.command, mcpDef.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
          const mcpRl = createInterface({ input: mcpProc.stdout });
          mcpRl.on('line', l => {
            const msg = JSON.parse(l);
            const w = mcpPending.get(msg.id);
            if (!w) return;
            mcpPending.delete(msg.id);
            w.resolve(msg);
          });
        }
        send({
          jsonrpc: '2.0', id: m.id,
          result: {
            sessionId: 'agy-sess-' + randomUUID().slice(0, 8),
            models: {
              currentModelId: 'gemini-4-neon-high',
              availableModels: [
                { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (low)' },
                { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (high)' },
                { modelId: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (medium)' },
              ],
            },
            configOptions: [
              { id: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] },
              { id: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
            ],
          },
        });
        return;
      }
      if (m.method === 'session/set_config_option') {
        agyObserved.configs.push({ configId: m.params.configId, value: m.params.value });
        send({ jsonrpc: '2.0', id: m.id, result: { configOptions: [] } });
        return;
      }
      if (m.method === 'session/prompt') {
        agyObserved.promptBlocks = m.params.prompt;
        const sid = m.params.sessionId;
        try {
          // 1. Verify server/discover returns -32601 on real agy-mcp-bridge.mjs
          const disc = await mcpCall('server/discover', {});
          agyObserved.discoverCode = disc.error?.code;
          await mcpCall('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock-agy', version: '1.0' } });
          mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          const toolsResp = await mcpCall('tools/list', {});
          assert.ok(toolsResp.result.tools.some(x => x.name === 'workspace_read_file'));
          assert.ok(toolsResp.result.tools.some(x => x.name === 'session_read_attachment'));

          // 2. Built-in local tool MUST be denied!
          agyObserved.builtinDecision = await askClient('session/request_permission', {
            sessionId: sid,
            toolCall: { toolCallId: 'tc-deny', name: 'run_command', title: 'run_command' },
            options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
          });
          // 3. MCP workspace tool MUST be allowed!
          agyObserved.mcpDecision = await askClient('session/request_permission', {
            sessionId: sid,
            toolCall: { toolCallId: 'tc-read', name: 'mcp_anywhere_workspace_workspace_read_file', title: 'mcp_anywhere_workspace_workspace_read_file' },
            options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
          });

          // 4. Execute real workspace_read_file & session_read_attachment via real agy-mcp-bridge.mjs
          const wsRes = await mcpCall('tools/call', { name: 'workspace_read_file', arguments: { path: 'notes.txt', offset: 0, length: 5 } });
          agyObserved.wsReadOk = !wsRes.result?.isError;
          const attRes = await mcpCall('tools/call', { name: 'session_read_attachment', arguments: { attachment: 'spec.txt' } });
          agyObserved.attReadText = attRes.result?.content?.[0]?.text ?? '';

          // 5. Stream thinking + text + usage
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '正在通过 Antigravity 分析…' } } } });
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Antigravity ' } } } });
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '工作区验证成功！' } } } });
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 230, size: 200000 } } });
          send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 150, outputTokens: 80, cachedReadTokens: 20 } } });
        } catch (err) {
          send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: err.message } });
        }
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
  const { removeWorkspace } = await import('../directory.mjs');

  createUser('coder', 'v04 strong pass', false);
  const server = await startServer({
    host: '127.0.0.1', port: 0, cert: certPath, key: keyPath,
    stateDir: hostState, codexSocket, codexCwd: dir,
    antigravitySocket: agySocket, antigravityCwd: dir,
    antigravityMcpDir: dir,
    mcpPath: join(import.meta.dirname, '../wan/mcp.mjs'),
  });
  t.after(async () => { await server.close(); db.close(); });

  const streamEvents = [];
  const client = new DeviceClient({
    name: 'Test Device', url: `https://127.0.0.1:${server.port}`, ca: certPath, stateDir: clientState,
    projects: [{ label: 'Project A', path: projectA }],
  }, {
    onStream: msg => streamEvents.push(msg),
    launcher: () => () => ({ read: async () => ({ version: 1, ok: true, calls: 1, response: { content: [{ type: 'text', text: 'ok' }] } }) }),
  });
  t.after(() => client.suspend());

  await client.control('login', { username: 'coder', password: 'v04 strong pass' });
  // Wait for project broker to reach ready
  let st;
  for (let i = 0; i < 40; i++) {
    st = await client.control('state');
    if (st.projects[0]?.ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(st.projects[0].ready, true);
  assert.equal(st.chatEngine, 'codex');
  assert.deepEqual(st.engines, ['codex', 'antigravity']);
  assert.equal(st.models[0].id, 'gpt-5.4');
  assert.ok(st.engineModels.antigravity.some(m => m.id === 'gemini-4-neon'));

  const wsId = st.projects[0].id;
  await client.control('permission', { workspaceId: wsId, mode: 'read' });
  for (let i = 0; i < 30; i++) {
    st = await client.control('state');
    if (st.projects[0].mode === 'read' && st.projects[0].ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(st.projects[0].mode, 'read');

  // Create session with options, rename, update effort
  const created = await client.control('create', { workspaceId: wsId, requestId: randomUUID(), title: '初始标题', options: { model: 'gpt-5.4', effort: 'medium' } });
  const renamed = await client.control('renameSession', { sessionId: created.id, title: '重命名后的会话' });
  assert.equal(renamed.title, '重命名后的会话');
  const opted = await client.control('setSessionOptions', { sessionId: created.id, effort: 'high' });
  assert.equal(opted.options.effort, 'high');
  assert.equal(opted.options.model, 'gpt-5.4');

  // Subscribe to SSE live stream
  await client.control('subscribe', { sessionId: created.id, afterSeq: 0 });
  await new Promise(r => setTimeout(r, 80));

  // Upload a text attachment and a tiny PNG attachment
  const txtAtt = await client.control('uploadAttachment', {
    sessionId: created.id, name: 'spec.txt', mime: 'text/plain',
    dataBase64: Buffer.from('SPEC_CONTENT_42\nline2\n').toString('base64'),
  });
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const imgAtt = await client.control('uploadAttachment', {
    sessionId: created.id, name: 'shot.png', mime: 'image/png', dataBase64: tinyPng.toString('base64'),
  });

  // Send message referencing both attachments
  await client.control('send', { sessionId: created.id, requestId: randomUUID(), text: '请看附件', attachments: [txtAtt.id, imgAtt.id] });

  // Wait for turn_end via SSE stream!
  for (let i = 0; i < 60; i++) {
    if (streamEvents.some(e => e.type === 'events' && e.payload.events.some(r => r.event.type === 'turn_end'))) break;
    await new Promise(r => setTimeout(r, 80));
  }
  assert.equal(observed.turnStart.effort, 'high');
  assert.equal(observed.turnStart.model, 'gpt-5.4');
  assert.ok(observed.turnStart.input.some(i => i.type === 'localImage' && i.path.endsWith('shot.png')));
  assert.ok(observed.attachmentToolReply?.success);
  assert.match(observed.attachmentToolReply.contentItems[0].text, /SPEC_CONTENT_42/);
  assert.ok(streamEvents.some(e => e.type === 'delta' && e.payload.delta.kind === 'thinking' && e.payload.delta.text.includes('正在分析附件')));
  assert.ok(streamEvents.some(e => e.type === 'delta' && e.payload.delta.kind === 'text' && e.payload.delta.text.includes('流式回复')));

  // Verify persisted events and historyBefore pagination
  const all = await client.control('history', { sessionId: created.id, afterSeq: 0 });
  const turnEnd = all.events.find(r => r.event.type === 'turn_end');
  assert.ok(turnEnd?.event.ok);
  assert.equal(turnEnd.event.usage.outputTokens, 120);
  const older = await client.control('historyBefore', { sessionId: created.id, beforeSeq: all.throughSeq });
  assert.ok(older.events.length >= 1);
  assert.equal(older.firstSeq, 1);

  // Switch the same session to Antigravity CLI engine, verify ACP + real agy-mcp-bridge.mjs + strict built-in tool denial
  const switched = await client.control('setSessionOptions', { sessionId: created.id, agent: 'antigravity', model: 'claude-sonnet-5-5', effort: 'low' });
  assert.equal(switched.options.agent, 'antigravity');
  const prevTurnEnds = streamEvents.filter(e => e.type === 'events' && e.payload.events.some(r => r.event.type === 'turn_end')).length;
  await client.control('send', { sessionId: created.id, requestId: randomUUID(), text: '请用 Antigravity 读取 notes.txt 并查看附件', attachments: [txtAtt.id, imgAtt.id] });
  for (let i = 0; i < 80; i++) {
    const curEnds = streamEvents.filter(e => e.type === 'events' && e.payload.events.some(r => r.event.type === 'turn_end')).length;
    if (curEnds > prevTurnEnds) break;
    await new Promise(r => setTimeout(r, 80));
  }
  assert.equal(agyObserved.discoverCode, -32601);
  assert.equal(agyObserved.builtinDecision?.outcome?.optionId, 'deny');
  assert.equal(agyObserved.mcpDecision?.outcome?.optionId, 'allow');
  assert.equal(agyObserved.wsReadOk, true);
  assert.match(agyObserved.attReadText, /SPEC_CONTENT_42/);
  assert.ok(agyObserved.promptBlocks?.some(b => b.type === 'image' && b.mimeType === 'image/png'));
  assert.ok(agyObserved.configs.some(c => c.configId === 'model' && c.value === 'claude-sonnet-5-5'));
  assert.ok(agyObserved.configs.some(c => c.configId === 'thought_level' && c.value === 'low'));
  assert.ok(streamEvents.some(e => e.type === 'delta' && e.payload.delta.kind === 'thinking' && e.payload.delta.text.includes('Antigravity 分析')));
  assert.ok(streamEvents.some(e => e.type === 'delta' && e.payload.delta.kind === 'text' && e.payload.delta.text.includes('工作区验证成功')));

  const allAfterAgy = await client.control('history', { sessionId: created.id, afterSeq: all.throughSeq });
  assert.ok(allAfterAgy.events.some(r => r.event.type === 'tool_call' && r.event.name === 'workspace_read_file' && r.event.status === 'completed'));
  assert.ok(allAfterAgy.events.some(r => r.event.type === 'assistant_text' && r.event.engine === 'antigravity' && r.event.text.includes('工作区验证成功')));
  const agyEnd = allAfterAgy.events.find(r => r.event.type === 'turn_end');
  assert.equal(agyEnd?.event.ok, true);
  assert.equal(agyEnd?.event.usage?.outputTokens, 80);

  // Test unknown task local review flow end-to-end
  const localProject = client.locals.get(wsId);
  const opId = randomUUID();
  const fakeReq = { scope: { accountId: String(st.user.id), deviceId: st.deviceId, workspaceId: wsId, sessionId: created.id, turnId: randomUUID(), turnEpoch: 1, grantVersion: localProject.agent.grant.grantVersion }, toolCallId: 'c1', kind: 'dc.tool', cwdRelative: '.', args: { tool: 'write_file', arguments: { path: 'notes.txt', content: 'x', mode: 'rewrite', expectedRevision: null } }, expiresAt: Date.now() + 60000 };
  localProject.agent.journal.put('ops', opId, {
    operationId: opId, taskId: randomUUID(), requestHash: hash(fakeReq),
    request: fakeReq, state: 'unknown', reason: 'WORKSPACE_COMMIT_UNCERTAIN', lastSeq: 0, result: null, pid: null, starts: 1, cancelId: null, acknowledgedSeq: 0,
  });
  const stateWithUnknown = await client.control('state');
  assert.equal(stateWithUnknown.projects[0].unknownCount, 1);
  const listBeforeRevoke = await client.control('reviewList', { workspaceId: wsId });
  assert.equal(listBeforeRevoke.revoked, false);
  assert.equal(listBeforeRevoke.items[0].needsRevoke, true);

  // Revoke permission, fetch preview digest, submit review
  await client.control('permission', { workspaceId: wsId, mode: 'revoked' });
  const listAfterRevoke = await client.control('reviewList', { workspaceId: wsId });
  assert.equal(listAfterRevoke.revoked, true);
  assert.match(listAfterRevoke.items[0].expectedDigest, /^[a-f0-9]{64}$/);
  const reviewed = await client.control('reviewSubmit', {
    workspaceId: wsId, requestId: randomUUID(), operationId: opId,
    expectedDigest: listAfterRevoke.items[0].expectedDigest, note: '已本地核实 notes.txt 完好',
  });
  assert.equal(reviewed.state, 'reviewed');
  assert.equal(reviewed.executionOutcome, 'unknown');
  assert.equal((await client.control('state')).projects[0].unknownCount, 0);

  // Delete session cleanly & verify attachment dir removed
  await client.control('unsubscribe', {});
  const delRes = await client.control('deleteSession', { sessionId: created.id });
  assert.equal(delRes.ok, true);
  assert.equal((await client.control('state')).sessions.length, 0);
  assert.equal(existsSync(join(hostState, 'u' + st.user.id, 'attachments', created.id)), false);

  // Verify removeWorkspace on directory
  const rem = removeWorkspace(client.signed.token, wsId);
  assert.equal(rem.ok, true);
});

test('linuxWorkspace supports read, write, edit, patch, move, delete, search, shell and blocks symlinks', async t => {
  const { linuxWorkspace } = await import('../linux-workspace.mjs');
  const { symlinkSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-linux-ws-'));
  const outside = mkdtempSync(join(tmpdir(), 'anywhere-linux-out-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'hello.txt'), 'line1\nline2\nline3\n');
  writeFileSync(join(outside, 'secret.txt'), 'TOP_SECRET\n');
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'escape.txt'));

  const ws = linuxWorkspace();
  const rootId = ws.identifyRoot(dir);
  const runOp = (kind, args, caps = ['dc.tool', 'dc.search', 'dc.run', 'workspace.write', 'workspace.exec']) => {
    const launch = ws.launcher({ workspaceRoot: dir, rootIdentity: rootId, readOnly: !caps.includes('workspace.write') });
    const spec = launch({ request: { kind, cwdRelative: '.', args } }, { capabilities: caps });
    return spec.read ? spec.read() : spec.perform(new AbortController().signal, () => {});
  };

  // Read + revision
  const r1 = await runOp('dc.tool', { tool: 'read_file', arguments: { path: 'hello.txt', offset: 0, length: 10 } });
  assert.equal(r1.ok, true);
  assert.match(r1.response.content[0].text, /line2/);
  const rev1 = r1.fileVersions[0].revision;

  // Symlink escape denied
  await assert.rejects(() => runOp('dc.tool', { tool: 'read_file', arguments: { path: 'escape.txt', offset: 0, length: 5 } }), /SYMLINK_DENIED/);

  // Write with wrong revision rejected; right revision succeeds
  await assert.rejects(() => runOp('dc.tool', { tool: 'write_file', arguments: { path: 'hello.txt', content: 'x', mode: 'rewrite', expectedRevision: 'file-v1:' + '0'.repeat(64) } }), /FILE_REVISION_CONFLICT/);
  const ed = await runOp('dc.tool', { tool: 'edit_block', arguments: { file_path: 'hello.txt', old_string: 'line2', new_string: 'LINE_TWO', expected_replacements: 1, expectedRevision: rev1 } });
  assert.equal(ed.ok, true);
  const rev2 = ed.fileVersions[0].revision;

  // Apply patch (update + add)
  const patched = await runOp('dc.tool', {
    tool: 'apply_patch',
    arguments: {
      patch: '*** Begin Patch\n*** Update File: hello.txt\n@@\n line1\n-LINE_TWO\n+LINE_2_PATCHED\n*** Add File: sub/added.txt\n+fresh\n*** End Patch',
      expectedRevisions: { 'hello.txt': rev2, 'sub/added.txt': null },
    },
  });
  assert.equal(patched.ok, true);
  assert.match(readFileSync(join(dir, 'hello.txt'), 'utf8'), /LINE_2_PATCHED/);
  assert.equal(readFileSync(join(dir, 'sub/added.txt'), 'utf8'), 'fresh\n');

  // Move + Delete
  const addedRev = patched.fileVersions.find(v => v.path === 'sub/added.txt').revision;
  const moved = await runOp('dc.tool', { tool: 'move_file', arguments: { fromPath: 'sub/added.txt', toPath: 'sub/moved.txt', expectedFromRevision: addedRev, expectedToRevision: null } });
  assert.equal(moved.ok, true);
  const deleted = await runOp('dc.tool', { tool: 'delete_file', arguments: { path: 'sub/moved.txt', expectedRevision: moved.fileVersions[0].revision } });
  assert.equal(deleted.ok, true);

  // Search + Shell run
  const found = await runOp('dc.search', { path: '.', pattern: 'LINE_2_PATCHED', searchType: 'content', literalSearch: true, maxResults: 10 });
  assert.match(found.response.content[0].text, /hello\.txt:2:/);
  const sh = await runOp('dc.run', { command: 'echo LINUX_EXEC_OK' });
  assert.equal(sh.ok, true);
  assert.match(sh.response.content[0].text, /LINUX_EXEC_OK/);
});
