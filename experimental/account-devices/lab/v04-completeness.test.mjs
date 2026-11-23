import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  contract.validate('setSessionOptions', { sessionId: id, model: 'gpt-5.4', effort: 'high' });
  contract.validate('setSessionOptions', { sessionId: id, model: null });
  assert.throws(() => contract.validate('setSessionOptions', { sessionId: id, effort: 'turbo' }), /INVALID_FIELDS/);
  contract.validate('send', { sessionId: id, requestId: id, text: 'a'.repeat(40000) });
  contract.validate('send', { sessionId: id, requestId: id, text: '看附件', attachments: [id] });
  assert.throws(() => contract.validate('send', { sessionId: id, requestId: id, text: 'x', attachments: ['not-a-uuid'] }), /INVALID_ID/);
  contract.validate('create', { workspaceId: id, requestId: id, title: 'T', options: { model: 'gpt-5.4', effort: 'medium' } });
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

  process.env.DATA_DIR = authDir;
  const { createUser } = await import('../../../server/dist/auth.js');
  const { db } = await import('../../../server/dist/db.js');
  const { startServer } = await import('../host.mjs');
  const { DeviceClient } = await import('../client.mjs');
  const { removeWorkspace } = await import('../directory.mjs');

  createUser('coder', 'v04 strong pass', false);
  const server = await startServer({
    host: '127.0.0.1', port: 0, cert: certPath, key: keyPath,
    stateDir: hostState, codexSocket, codexCwd: dir,
    mcpPath: join(import.meta.dirname, '../../workspace/mcp.mjs'),
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
  assert.equal(st.models[0].id, 'gpt-5.4');

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
