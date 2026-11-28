import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { WebSocketServer } from '../execution/node_modules/ws/wrapper.mjs';
import { buildAccessibilitySnapshot } from './accessibility.mjs';
import { BrowserManager } from './manager.mjs';
import { BrowserSettingsStore, normalizeCdpUrl } from './settings.mjs';
import { findBrowserBinary } from './cdp-client.mjs';
import { BackgroundProcessManager } from '../workspace/bg-processes.mjs';
import { BROWSER_READ_TOOL_NAMES, BROWSER_TOOL_NAMES, PROCESS_TOOL_NAMES, browserInstructions, listTools, normalize } from '../workspace/catalog.mjs';
import { linuxWorkspace } from '../account-devices/linux-workspace.mjs';
import { DeviceClient } from '../account-devices/client.mjs';
import { register } from '../desktop-commander/adapter.mjs';
import { CAPABILITIES, hash } from '../execution/protocol.mjs';
import { Journal } from '../execution/journal.mjs';
import { LocalAgent } from '../execution/agent.mjs';
import contract from '../account-devices/contract.cjs';

if (!CAPABILITIES.includes('dc.tool.v1')) register();

test('browser settings enforce loopback-only CDP URLs and persist atomically', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-browser-cfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(normalizeCdpUrl('auto'), 'auto');
  assert.equal(normalizeCdpUrl('9222'), 'http://127.0.0.1:9222');
  assert.equal(normalizeCdpUrl('http://127.0.0.1:9333/'), 'http://127.0.0.1:9333');
  assert.equal(normalizeCdpUrl('http://localhost:9222'), 'http://localhost:9222');
  assert.throws(() => normalizeCdpUrl('http://192.168.1.10:9222'), /CDP_LOOPBACK_REQUIRED/);
  assert.throws(() => normalizeCdpUrl('https://example.com:9222'), /CDP_LOOPBACK_REQUIRED/);
  assert.throws(() => normalizeCdpUrl('file:///etc/passwd'), /INVALID_CDP_URL/);

  let changes = 0;
  const store = new BrowserSettingsStore(dir, { onChange: () => { changes++; } });
  assert.equal(store.get().builtin.enabled, false);
  assert.equal(store.get().builtin.autoShow, false);
  assert.equal(store.get().daily.enabled, false);

  const updated = store.update({
    builtin: { enabled: true, autoShow: true },
    daily: { enabled: true, access: 'read', backend: 'playwright-mcp', cdpUrl: '9222' },
  });
  assert.equal(changes, 1);
  assert.equal(updated.builtin.enabled, true);
  assert.equal(updated.builtin.autoShow, true);
  assert.equal(updated.daily.access, 'read');
  assert.equal(updated.daily.backend, 'playwright-mcp');
  assert.equal(updated.daily.cdpUrl, 'http://127.0.0.1:9222');

  const reloaded = new BrowserSettingsStore(dir);
  assert.deepEqual(reloaded.get(), updated);
});

test('desktop contract strictly validates all browser control IPC routes', () => {
  contract.validate('browserStatus', {});
  contract.validate('browserUpdateSettings', {
    builtin: { enabled: true, autoShow: true },
    daily: { enabled: true, access: 'read', backend: 'chrome-devtools-mcp', cdpUrl: 'http://127.0.0.1:9222' },
  });
  contract.validate('browserTestDaily', { cdpUrl: 'auto' });
  contract.validate('browserLaunchDaily', { port: 9222 });
  contract.validate('browserShowBuiltin', {});
  contract.validate('browserHideBuiltin', {});
  contract.validate('browserResetBuiltin', {});
  contract.validate('browserDockSync', { open: true, covered: false, bounds: { x: 640, y: 98, width: 520, height: 700 } });
  contract.validate('browserDockNavigate', { action: 'goto', url: 'http://localhost:3000/' });
  contract.validate('browserDockNavigate', { action: 'back' });
  contract.validate('browserDockNavigate', { action: 'selectTab', tabId: 'tab-1234' });

  assert.throws(() => contract.validate('browserUpdateSettings', { builtin: { enabled: 'yes' } }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('browserUpdateSettings', { daily: { access: 'admin' } }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('browserUpdateSettings', { daily: { backend: 'evil-mcp' } }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('browserLaunchDaily', { port: 80 }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('browserDockSync', { bounds: { x: -1, y: 0, width: 100, height: 100 } }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('browserDockNavigate', { action: 'goto', url: 'file:///etc/passwd' }), /URL_SCHEME_DENIED/);
  assert.throws(() => contract.validate('browserDockNavigate', { action: 'selectTab' }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('browserDockNavigate', { action: 'eval' }), /INVALID_FIELDS/);
});

test('buildAccessibilitySnapshot compacts AX tree and emits stable refs mapped to backendDOMNodeId', () => {
  const nodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Login' }, childIds: ['2', '3', '6'] },
    { nodeId: '2', role: { value: 'generic' }, ignored: false, childIds: ['4'] },
    { nodeId: '4', role: { value: 'heading' }, name: { value: 'Welcome' }, backendDOMNodeId: 101, properties: [{ name: 'level', value: { value: 1 } }], childIds: [] },
    { nodeId: '3', role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'alice@example.com' }, backendDOMNodeId: 102, properties: [{ name: 'focused', value: { value: true } }], childIds: [] },
    { nodeId: '6', role: { value: 'button' }, name: { value: 'Sign in' }, backendDOMNodeId: 103, childIds: ['7'] },
    { nodeId: '7', role: { value: 'StaticText' }, name: { value: 'Sign in' }, childIds: [] },
  ];
  const snap = buildAccessibilitySnapshot(nodes, { url: 'http://localhost:3000/login', title: 'Login' });
  assert.match(snap.text, /Page: Login \(http:\/\/localhost:3000\/login\)/);
  assert.match(snap.text, /heading "Welcome" \[ref=e1, level=1\]/);
  assert.match(snap.text, /textbox "Email" \[ref=e2, focused, value="alice@example.com"\]/);
  assert.match(snap.text, /button "Sign in" \[ref=e3\]/);
  assert.doesNotMatch(snap.text, /text: "Sign in"/);
  assert.equal(snap.refMap.get('e2')?.backendDOMNodeId, 102);
  assert.equal(snap.refMap.get('e3')?.backendDOMNodeId, 103);
});

test('catalog dynamically adapts browser target enum, read-only daily mode, and rejects dangerous URLs', () => {
  const readGrant = { revoked: false, mode: 'read', capabilities: ['dc.tool', 'dc.search'] };
  const execGrant = { revoked: false, mode: 'execute', capabilities: ['dc.tool', 'dc.search', 'workspace.write', 'workspace.exec'] };

  // Legacy callers without supportedTools see no opt-in process/browser tools
  const legacyExec = listTools(execGrant);
  assert.ok(!legacyExec.some(t => t.name === 'workspace_bg_start'));
  assert.ok(!legacyExec.some(t => t.name === 'browser_navigate'));

  // Process tools advertised with execute grant
  const withBg = listTools(execGrant, true, ['workspace_read_file', ...PROCESS_TOOL_NAMES]);
  assert.ok(withBg.some(t => t.name === 'workspace_bg_start'));

  // Daily read-only mode advertises ONLY read browser tools and narrows target enum to ['daily']
  const dailyReadSandbox = {
    platform: 'linux',
    supportedTools: ['workspace_read_file', ...BROWSER_READ_TOOL_NAMES],
    browser: { builtin: { enabled: false }, daily: { enabled: true, access: 'read', backend: 'cdp' } },
  };
  const dailyReadTools = listTools(readGrant, true, dailyReadSandbox.supportedTools, dailyReadSandbox);
  assert.ok(dailyReadTools.some(t => t.name === 'browser_snapshot'));
  assert.ok(!dailyReadTools.some(t => t.name === 'browser_click'));
  const snapSchema = dailyReadTools.find(t => t.name === 'browser_snapshot').inputSchema;
  assert.deepEqual(snapSchema.properties.target.enum, ['daily']);
  assert.match(browserInstructions(dailyReadSandbox), /read-only/);

  // Dangerous URL schemes rejected at schema/adapter validation layer
  assert.throws(() => normalize('browser_navigate', { url: 'file:///etc/passwd' }), /URL_SCHEME_DENIED/);
  assert.throws(() => normalize('browser_navigate', { url: 'javascript:alert(1)' }), /URL_SCHEME_DENIED/);
  assert.throws(() => normalize('browser_navigate', { url: 'anywhere-desktop://app/index.html' }), /URL_SCHEME_DENIED/);
  normalize('browser_navigate', { url: 'http://localhost:5173', target: 'builtin' });
});

test('BackgroundProcessManager supports start, streaming output cursor, stdin, stop and permission-revoke cleanup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-bg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const bg = new BackgroundProcessManager({ stateDir: dir, platform: process.platform });
  t.after(() => bg.stopAll());

  const started = await bg.start({
    cwd: dir,
    command: 'echo READY; while IFS= read -r line; do echo "ECHO:$line"; done',
    waitMs: 500,
  });
  assert.equal(started.running, true);
  assert.match(started.output, /READY/);
  assert.equal(bg.list().length, 1);

  bg.input({ processId: started.processId, input: 'hello-world\n' });
  const next = await bg.output({ processId: started.processId, afterSeq: started.nextSeq, waitMs: 2000 });
  assert.match(next.output, /ECHO:hello-world/);

  const stopped = await bg.stop({ processId: started.processId });
  assert.equal(stopped.running, false);

  // Verify LocalAgent revoking execute mode automatically terminates workspace bg processes
  const wsDir = join(dir, 'ws');
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, 'hello.txt'), 'needle in haystack\n');
  const outside = join(dir, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'needle secret\n');
  symlinkSync(outside, join(wsDir, 'escape'));

  const ws = linuxWorkspace();
  const journal = new Journal(join(dir, 'j.sqlite'));
  const identity = { accountId: 'acc', deviceId: 'dev', workspaceId: 'ws1' };
  const launch = ws.launcher({ workspaceRoot: wsDir, rootIdentity: ws.identifyRoot(wsDir), stateDir: dir });
  const agent = new LocalAgent(journal, identity, {
    stateDir: dir,
    workspace: {
      label: 'ws',
      getSandbox: ws.getSandbox,
      onGrantChange: g => ws.onGrantChange(g, dir),
      onClose: () => ws.onClose(dir),
    },
    launcher: launch,
  });
  t.after(async () => {
    await agent.close();
    journal.close();
  });
  agent.control('setMode', { requestId: randomUUID(), expectedVersion: 1, mode: 'execute' });

  const makeEnv = (reqBody) => {
    const req = {
      scope: { ...identity, grantVersion: agent.grant.grantVersion, sessionId: 's1', turnId: randomUUID(), turnEpoch: 1 },
      toolCallId: randomUUID(),
      ...reqBody,
      expiresAt: Date.now() + 20000,
    };
    return { operationId: randomUUID(), requestHash: hash(req), request: req };
  };
  const runOp = async (reqBody) => {
    const env = makeEnv(reqBody);
    agent.start(env);
    for (let i = 0; i < 100; i++) {
      const op = journal.get('ops', env.operationId);
      if (op.state === 'succeeded' || op.state === 'failed') return op;
      await new Promise(r => setTimeout(r, 25));
    }
    throw Error('OP_TIMEOUT');
  };

  // Search works and does not follow symlinked directory
  const searchOp = await runOp(normalize('workspace_search', { path: '.', pattern: 'needle', searchType: 'content', literal: true, maxResults: 10 }));
  assert.equal(searchOp.state, 'succeeded');
  const searchText = searchOp.result.tool.response.content[0].text;
  assert.match(searchText, /hello\.txt:1:.*needle/);
  assert.doesNotMatch(searchText, /secret/);

  // Start background sleeper via workspace_bg_start, then downgrade to read -> must kill it
  const bgOp = await runOp(normalize('workspace_bg_start', { command: 'echo BG_UP; sleep 60', waitMs: 300 }));
  assert.equal(bgOp.state, 'succeeded');
  const bgInfo = JSON.parse(bgOp.result.tool.response.content[0].text);
  assert.equal(bgInfo.running, true);
  assert.match(bgInfo.output, /BG_UP/);

  agent.control('setMode', { requestId: randomUUID(), expectedVersion: agent.grant.grantVersion, mode: 'read' });
  await new Promise(r => setTimeout(r, 150));
  let alive = true;
  try { process.kill(bgInfo.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'Background process must be killed when execute permission is downgraded');
});

test('BrowserManager orchestrates built-in Electron bridge and daily CDP takeover with strict permission isolation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-browser-mgr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 1. Mock Electron built-in browser HTTP bridge
  const token = randomBytes(16).toString('hex');
  const builtinEvents = [];
  let builtinVisible = false;
  let builtinUrl = 'about:blank';
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64');

  const builtinServer = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(403); res.end('{}'); return; }
    let raw = '';
    for await (const c of req) raw += c;
    const { action, params } = JSON.parse(raw);
    builtinEvents.push({ action, method: params?.method });
    const ok = result => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result })); };
    if (action === 'status') return ok({ connected: true, browser: 'Electron Mock', tabCount: 1, visible: builtinVisible });
    if (action === 'show') { builtinVisible = true; return ok({ ok: true, visible: true }); }
    if (action === 'hide') { builtinVisible = false; return ok({ ok: true, visible: false }); }
    if (action === 'reset') { builtinUrl = 'about:blank'; return ok({ ok: true }); }
    if (action === 'listTabs') return ok({ tabs: [{ id: 'tab-1', title: 'Dev App', url: builtinUrl, active: true }] });
    if (action === 'getLogs') return ok({ tabId: 'tab-1', console: [{ level: 'log', text: 'hello dev' }], network: [] });
    if (action === 'cdp') {
      const m = params.method;
      if (m === 'Page.navigate') { builtinUrl = params.params.url; return ok({ tabId: 'tab-1', result: { frameId: 'f1' } }); }
      if (m === 'Runtime.evaluate') {
        const expr = params.params.expression;
        if (expr.includes('readyState')) return ok({ tabId: 'tab-1', result: { result: { value: { readyState: 'complete', url: builtinUrl, title: 'Dev App' } } } });
        if (expr.includes('location.href')) return ok({ tabId: 'tab-1', result: { result: { value: { url: builtinUrl, title: 'Dev App' } } } });
        return ok({ tabId: 'tab-1', result: { result: { value: 'eval-ok' } } });
      }
      if (m === 'Accessibility.getFullAXTree') {
        return ok({
          tabId: 'tab-1',
          result: {
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Dev App' }, childIds: ['2'] },
              { nodeId: '2', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 42, childIds: [] },
            ],
          },
        });
      }
      if (m === 'DOM.resolveNode') return ok({ tabId: 'tab-1', result: { object: { objectId: 'obj-42' } } });
      if (m === 'Runtime.callFunctionOn') return ok({ tabId: 'tab-1', result: { result: { value: { x: 120, y: 80, width: 100, height: 32, left: 70, top: 64 } } } });
      if (m === 'Page.captureScreenshot') return ok({ tabId: 'tab-1', result: { data: fakeJpeg } });
      return ok({ tabId: 'tab-1', result: {} });
    }
    res.writeHead(400); res.end('{}');
  });
  await new Promise(resolve => builtinServer.listen(0, '127.0.0.1', resolve));
  t.after(() => builtinServer.close());
  const builtinUrlEndpoint = `http://127.0.0.1:${builtinServer.address().port}/action`;

  // 2. Mock Daily Chrome CDP server (HTTP discovery + WebSocket CDP)
  let dailyWsClosed = false;
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', ws => {
    ws.on('close', () => { dailyWsClosed = true; });
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      let result = {};
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        if (expr.includes('location.href')) result = { result: { value: { url: 'https://mail.example.com', title: 'Daily Inbox' } } };
        else result = { result: { value: 42 } };
      } else if (msg.method === 'Accessibility.getFullAXTree') {
        result = {
          nodes: [
            { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Daily Inbox' }, childIds: ['2'] },
            { nodeId: '2', role: { value: 'heading' }, name: { value: 'Inbox (3)' }, backendDOMNodeId: 9, childIds: [] },
          ],
        };
      } else if (msg.method === 'Page.captureScreenshot') {
        result = { data: fakeJpeg };
      }
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });

  const dailyServer = http.createServer((req, res) => {
    const port = dailyServer.address().port;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/json/version') {
      res.end(JSON.stringify({ Browser: 'Chrome/136.0-Mock', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/1` }));
      return;
    }
    if (req.url === '/json/list') {
      res.end(JSON.stringify([{ id: 'daily-tab-1', type: 'page', title: 'Daily Inbox', url: 'https://mail.example.com', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }]));
      return;
    }
    res.end('{}');
  });
  dailyServer.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws)));
  await new Promise(resolve => dailyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => { wss.close(); dailyServer.close(); });
  const dailyHttpUrl = `http://127.0.0.1:${dailyServer.address().port}`;

  const mgr = new BrowserManager({
    stateDir: dir,
    builtinBridgeUrl: builtinUrlEndpoint,
    builtinBridgeToken: token,
  });
  t.after(() => mgr.close());

  // Initially both disabled
  assert.deepEqual(mgr.supportedTools(), []);
  await assert.rejects(() => mgr.execute('browser_snapshot', {}), /BROWSER_DISABLED/);

  // Enable built-in dev browser only
  mgr.updateSettings({ builtin: { enabled: true, autoShow: true } });
  assert.equal(mgr.supportedTools().length, BROWSER_TOOL_NAMES.length);
  await assert.rejects(() => mgr.execute('browser_snapshot', { target: 'daily' }), /BROWSER_DAILY_DISABLED/);

  const nav = await mgr.execute('browser_navigate', { url: 'http://localhost:5173/app' });
  assert.equal(nav.ok, true);
  assert.match(nav.response.content[0].text, /localhost:5173\/app/);

  const snap = await mgr.execute('browser_snapshot', {});
  assert.match(snap.response.content[0].text, /button "Submit" \[ref=e1\]/);

  const click = await mgr.execute('browser_click', { ref: 'e1' });
  assert.equal(click.ok, true);
  assert.ok(builtinEvents.some(e => e.method === 'Input.dispatchMouseEvent'));

  const shot = await mgr.execute('browser_screenshot', {});
  assert.equal(shot.response.content[0].type, 'image');
  assert.equal(shot.response.content[0].mimeType, 'image/jpeg');
  assert.equal(shot.response.content[0].data, fakeJpeg);

  // Enable daily browser in READ-ONLY mode
  const probe = await mgr.testDailyConnection(dailyHttpUrl);
  assert.equal(probe.ok, true);
  assert.equal(probe.browser, 'Chrome/136.0-Mock');
  assert.equal(probe.tabCount, 1);

  mgr.updateSettings({ daily: { enabled: true, access: 'read', cdpUrl: dailyHttpUrl } });
  const dailySnap = await mgr.execute('browser_snapshot', { target: 'daily' });
  assert.match(dailySnap.response.content[0].text, /Inbox \(3\)/);
  await assert.rejects(() => mgr.execute('browser_eval', { target: 'daily', expression: '1+1' }), /BROWSER_DAILY_READONLY/);

  // Upgrade daily browser to FULL mode -> eval succeeds
  mgr.updateSettings({ daily: { access: 'full' } });
  const dailyEval = await mgr.execute('browser_eval', { target: 'daily', expression: '21*2' });
  assert.equal(dailyEval.response.content[0].text, '42');

  // Turning daily browser OFF immediately closes CDP WebSocket
  mgr.updateSettings({ daily: { enabled: false } });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(dailyWsClosed, true);
});

test('end-to-end Codex turn dynamically discovers browser tools when toggled ON and receives inline screenshot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-browser-e2e-'));
  const authDir = join(dir, 'auth');
  const hostState = join(dir, 'host');
  const clientState = join(dir, 'client');
  const projectDir = join(dir, 'proj');
  mkdirSync(authDir, { recursive: true });
  mkdirSync(hostState, { recursive: true });
  mkdirSync(clientState, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'index.html'), '<h1>Hello</h1>');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const keyPath = join(dir, 'server.key');
  const certPath = join(dir, 'server.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });

  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64');
  const token = randomBytes(16).toString('hex');
  const builtinServer = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(403); res.end('{}'); return; }
    let raw = '';
    for await (const c of req) raw += c;
    const { action, params } = JSON.parse(raw);
    const ok = result => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result })); };
    if (action === 'status') return ok({ connected: true, browser: 'Electron Mock', tabCount: 1 });
    if (action === 'hide') return ok({ ok: true });
    if (action === 'cdp' && params.method === 'Runtime.evaluate') {
      return ok({ tabId: 'tab-1', result: { result: { value: { url: 'http://localhost:3000', title: 'Local Dev' } } } });
    }
    if (action === 'cdp' && params.method === 'Page.captureScreenshot') {
      return ok({ tabId: 'tab-1', result: { data: fakeJpeg } });
    }
    return ok({ tabId: 'tab-1', result: {} });
  });
  await new Promise(resolve => builtinServer.listen(0, '127.0.0.1', resolve));
  t.after(() => builtinServer.close());

  const observed = { dynamicToolNames: [], developerInstructions: '', toolResult: null };
  const codexSocket = join(dir, 'codex.sock');
  const codexServer = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => sock.write(JSON.stringify(obj) + '\n');
    let threadId = 'thr-' + randomUUID().slice(0, 8);
    let turnId = 'trn-' + randomUUID().slice(0, 8);
    rl.on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') return send({ id: m.id, result: { userAgent: 'mock-codex' } });
      if (m.method === 'model/list') return send({ id: m.id, result: { data: [{ id: 'gpt-5.4', displayName: 'GPT-5.4', supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium', isDefault: true }] } });
      if (m.method === 'thread/start') {
        observed.dynamicToolNames = (m.params.dynamicTools ?? []).map(x => x.name);
        observed.developerInstructions = m.params.developerInstructions ?? '';
        return send({ id: m.id, result: { thread: { id: threadId }, model: 'gpt-5.4' } });
      }
      if (m.method === 'turn/start') {
        send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } });
        setTimeout(() => {
          send({ id: 9001, method: 'item/tool/call', params: { threadId, turnId, callId: 'call-shot-1', tool: 'browser_screenshot', arguments: { target: 'builtin' } } });
        }, 30);
        return;
      }
      if (m.id === 9001) {
        observed.toolResult = m.result;
        send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'msg-1', type: 'agentMessage', text: 'I captured the screenshot.' } } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
      }
    });
  });
  await new Promise(resolve => codexServer.listen(codexSocket, resolve));
  t.after(() => codexServer.close());

  process.env.DATA_DIR = authDir;
  const { createUser } = await import('../account-devices/auth.mjs');
  const { startServer } = await import('../account-devices/host.mjs');
  createUser('browserdev', 'StrongPass123!', true);

  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    cert: certPath,
    key: keyPath,
    stateDir: hostState,
    codexSocket,
    launchLimiterOptions: { minDelayMs: 0, maxDelayMs: 0 },
  });
  t.after(() => server.close());

  let clientRef = null;
  const browserManager = new BrowserManager({
    stateDir: clientState,
    builtinBridgeUrl: `http://127.0.0.1:${builtinServer.address().port}/action`,
    builtinBridgeToken: token,
    onSettingsChange: () => clientRef?.notifyWorkspaceChanged(),
  });
  t.after(() => browserManager.close());
  const ws = linuxWorkspace({ browserManager });
  clientRef = new DeviceClient({
    name: 'TestLinuxDesktop',
    url: `https://127.0.0.1:${server.port}`,
    ca: certPath,
    stateDir: clientState,
    projects: [{ label: 'DemoWeb', path: projectDir }],
  }, { ...ws, browserManager });
  t.after(() => clientRef.suspend());

  await clientRef.control('login', { username: 'browserdev', password: 'StrongPass123!' });
  let st = await clientRef.control('state');
  const wid = st.projects[0].id;
  await clientRef.control('permission', { workspaceId: wid, mode: 'execute' });
  await clientRef.control('browserUpdateSettings', { builtin: { enabled: true, autoShow: false } });

  // Wait for broker to sync updated sandbox.browser & ready state
  for (let i = 0; i < 60; i++) {
    st = await clientRef.control('state');
    if (st.projects[0]?.ready && st.projects[0]?.browser?.builtin?.enabled) break;
    await new Promise(r => setTimeout(r, 80));
  }
  assert.equal(st.projects[0].browser?.builtin?.enabled, true);

  const session = await clientRef.control('create', { workspaceId: wid, requestId: randomUUID(), title: 'Browser Test', options: { agent: 'codex' } });
  await clientRef.control('send', { sessionId: session.id, requestId: randomUUID(), text: 'Take a screenshot of the dev browser.' });

  for (let i = 0; i < 100; i++) {
    const cur = (await clientRef.control('state')).sessions.find(x => x.id === session.id);
    if (!cur?.activeTurn) break;
    await new Promise(r => setTimeout(r, 60));
  }

  assert.ok(observed.dynamicToolNames.includes('browser_screenshot'));
  assert.ok(observed.dynamicToolNames.includes('workspace_bg_start'));
  assert.match(observed.developerInstructions, /target="builtin"/);
  assert.equal(observed.toolResult?.success, true);
  assert.equal(observed.toolResult?.contentItems?.[0]?.type, 'inputImage');
  assert.equal(observed.toolResult?.contentItems?.[0]?.imageUrl, `data:image/jpeg;base64,${fakeJpeg}`);
});

test('real headless Chrome smoke test (navigate, AX snapshot, type, click, screenshot, logs)', { skip: !findBrowserBinary() }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-real-chrome-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const html = `<!doctype html><html><head><title>Smoke App</title></head><body>
    <h1>Smoke Heading</h1>
    <input id="name" aria-label="Your Name" type="text" />
    <button id="go" onclick="document.getElementById('out').textContent='Hi ' + document.getElementById('name').value; console.log('CLICKED_OK');">Greet</button>
    <p id="out"></p>
  </body></html>`;
  const appServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  t.after(() => appServer.close());
  const url = `http://127.0.0.1:${appServer.address().port}/`;

  const mgr = new BrowserManager({ stateDir: dir, initialSettings: { builtin: { enabled: true, autoShow: false } } });
  t.after(() => mgr.close());

  const nav = await mgr.execute('browser_navigate', { target: 'builtin', url });
  assert.equal(nav.ok, true);
  assert.match(nav.response.content[0].text, /Smoke App/);

  const snap = await mgr.execute('browser_snapshot', { target: 'builtin' });
  const text = snap.response.content[0].text;
  assert.match(text, /heading "Smoke Heading"/);
  const inputRef = text.match(/textbox "Your Name" \[ref=(e\d+)/)?.[1];
  const btnRef = text.match(/button "Greet" \[ref=(e\d+)/)?.[1];
  assert.ok(inputRef && btnRef, `Expected refs in snapshot:\n${text}`);

  await mgr.execute('browser_type', { target: 'builtin', ref: inputRef, text: 'AnywhereMesh' });
  await mgr.execute('browser_click', { target: 'builtin', ref: btnRef });

  const waitRes = await mgr.execute('browser_wait', { target: 'builtin', text: 'Hi AnywhereMesh', timeoutMs: 3000 });
  assert.equal(waitRes.ok, true);

  const shot = await mgr.execute('browser_screenshot', { target: 'builtin' });
  assert.equal(shot.ok, true);
  assert.equal(shot.response.content[0].type, 'image');
  assert.ok(shot.response.content[0].data.length > 500);

  const logs = await mgr.execute('browser_logs', { target: 'builtin', kind: 'console' });
  assert.match(logs.response.content[0].text, /CLICKED_OK/);
});

test('end-to-end Antigravity turn discovers browser tools over MCP bridge and receives inline screenshot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-agy-browser-'));
  const authDir = join(dir, 'auth');
  const hostState = join(dir, 'host');
  const clientState = join(dir, 'client');
  const projectDir = join(dir, 'proj');
  mkdirSync(authDir, { recursive: true });
  mkdirSync(hostState, { recursive: true });
  mkdirSync(clientState, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const keyPath = join(dir, 'server.key');
  const certPath = join(dir, 'server.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });

  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64');
  const token = randomBytes(16).toString('hex');
  const builtinServer = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(403); res.end('{}'); return; }
    let raw = '';
    for await (const c of req) raw += c;
    const { action, params } = JSON.parse(raw);
    const ok = result => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result })); };
    if (action === 'status') return ok({ connected: true, browser: 'Electron Mock', tabCount: 1 });
    if (action === 'hide') return ok({ ok: true });
    if (action === 'cdp' && params.method === 'Runtime.evaluate') {
      return ok({ tabId: 'tab-1', result: { result: { value: { url: 'http://localhost:4000', title: 'Agy App' } } } });
    }
    if (action === 'cdp' && params.method === 'Page.captureScreenshot') {
      return ok({ tabId: 'tab-1', result: { data: fakeJpeg } });
    }
    return ok({ tabId: 'tab-1', result: {} });
  });
  await new Promise(resolve => builtinServer.listen(0, '127.0.0.1', resolve));
  t.after(() => builtinServer.close());

  const observed = { mcpTools: [], systemAppend: '', screenshotRes: null };
  const agySocket = join(dir, 'agy.sock');
  const agyServer = createNetServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => sock.write(JSON.stringify(obj) + '\n');
    let mcpSock = null;
    let mcpTok = null;
    const postMcp = payload => new Promise((resolve, reject) => {
      const raw = JSON.stringify(payload);
      const req = http.request({
        socketPath: mcpSock,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), Authorization: 'Bearer ' + mcpTok },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      req.on('error', reject);
      req.end(raw);
    });
    rl.on('line', async line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1 } });
      if (m.method === 'session/new') {
        const srv = m.params?.mcpServers?.[0];
        mcpSock = srv?.env?.find(e => e.name === 'ANYWHERE_MCP_SOCKET')?.value ?? null;
        mcpTok = srv?.env?.find(e => e.name === 'ANYWHERE_MCP_TOKEN')?.value ?? null;
        if (mcpSock && mcpTok) {
          observed.systemAppend = m.params?._meta?.antigravity?.systemPrompt?.append ?? '';
          const list = await postMcp({ method: 'tools/list', params: {} });
          observed.mcpTools = (list?.result?.tools ?? []).map(x => x.name);
        }
        return send({ id: m.id, result: { sessionId: 'agy-s1', models: { currentModelId: 'gemini-4-neon-high', availableModels: [{ modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (high)' }] } } });
      }
      if (m.method === 'session/prompt') {
        const call = await postMcp({ method: 'tools/call', params: { name: 'browser_screenshot', arguments: { target: 'builtin' } } });
        observed.screenshotRes = call?.result;
        send({ method: 'session/update', params: { sessionId: 'agy-s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Screenshot checked.' } } } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
    });
  });
  await new Promise(resolve => agyServer.listen(agySocket, resolve));
  t.after(() => agyServer.close());

  process.env.DATA_DIR = authDir;
  const { createUser } = await import('../account-devices/auth.mjs');
  const { startServer } = await import('../account-devices/host.mjs');
  createUser('agydev', 'StrongPass123!', true);

  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    cert: certPath,
    key: keyPath,
    stateDir: hostState,
    antigravitySocket: agySocket,
    launchLimiterOptions: { minDelayMs: 0, maxDelayMs: 0 },
  });
  t.after(() => server.close());

  let clientRef = null;
  const browserManager = new BrowserManager({
    stateDir: clientState,
    builtinBridgeUrl: `http://127.0.0.1:${builtinServer.address().port}/action`,
    builtinBridgeToken: token,
    onSettingsChange: () => clientRef?.notifyWorkspaceChanged(),
  });
  t.after(() => browserManager.close());
  const ws = linuxWorkspace({ browserManager });
  clientRef = new DeviceClient({
    name: 'TestAgyDesktop',
    url: `https://127.0.0.1:${server.port}`,
    ca: certPath,
    stateDir: clientState,
    projects: [{ label: 'AgyWeb', path: projectDir }],
  }, { ...ws, browserManager });
  t.after(() => clientRef.suspend());

  await clientRef.control('login', { username: 'agydev', password: 'StrongPass123!' });
  let st = await clientRef.control('state');
  const wid = st.projects[0].id;
  await clientRef.control('permission', { workspaceId: wid, mode: 'execute' });
  await clientRef.control('browserUpdateSettings', { builtin: { enabled: true, autoShow: false } });
  for (let i = 0; i < 60; i++) {
    st = await clientRef.control('state');
    if (st.projects[0]?.ready && st.projects[0]?.browser?.builtin?.enabled) break;
    await new Promise(r => setTimeout(r, 80));
  }

  const session = await clientRef.control('create', { workspaceId: wid, requestId: randomUUID(), title: 'Agy Browser', options: { agent: 'antigravity' } });
  await clientRef.control('send', { sessionId: session.id, requestId: randomUUID(), text: 'Inspect the page.' });

  for (let i = 0; i < 100; i++) {
    const cur = (await clientRef.control('state')).sessions.find(x => x.id === session.id);
    if (!cur?.activeTurn) break;
    await new Promise(r => setTimeout(r, 60));
  }

  assert.ok(observed.mcpTools.includes('browser_screenshot'));
  assert.ok(observed.mcpTools.includes('workspace_bg_start'));
  assert.match(observed.systemAppend, /target="builtin"/);
  assert.equal(observed.screenshotRes?.isError, false);
  assert.equal(observed.screenshotRes?.content?.[0]?.type, 'image');
  assert.equal(observed.screenshotRes?.content?.[0]?.data, fakeJpeg);
});
