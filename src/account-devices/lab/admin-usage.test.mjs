import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import contract from '../contract.cjs';

function makeCert(dir) {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { certPath, keyPath };
}

test('contract validates adminUsage route strictly', () => {
  assert.doesNotThrow(() => contract.validate('adminUsage', {}));
  for (const range of ['24h', '7d', '30d', 'all']) {
    assert.doesNotThrow(() => contract.validate('adminUsage', { range }));
    assert.doesNotThrow(() => contract.validate('adminUsage', { range, refreshQuota: true }));
    assert.doesNotThrow(() => contract.validate('adminUsage', { range, refreshQuota: false }));
  }
  assert.throws(() => contract.validate('adminUsage', { range: '90d' }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('adminUsage', { refreshQuota: '1' }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('adminUsage', { extra: true }), /INVALID_FIELDS/);
});

test('UsageTracker aggregates traffic, AI turns, backfill, measured deltas, and historical window quota attribution', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-usage-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'auth.db');
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      last_login_at INTEGER
    );
  `);
  const now = 1795700000000;
  db.prepare('INSERT INTO users(id, username, password_hash, created_at, is_admin) VALUES(?,?,?,?,?)').run(1, 'alice', 'x', now, 1);
  db.prepare('INSERT INTO users(id, username, password_hash, created_at, is_admin) VALUES(?,?,?,?,?)').run(2, 'bob', 'x', now, 0);

  const { UsageTracker, classifyQuotaGroup, computeTurnMetrics } = await import('../usage-stats.mjs');

  assert.equal(classifyQuotaGroup('codex', 'gpt-5.4'), 'codex');
  assert.equal(classifyQuotaGroup('codex', 'gpt-5.3-codex-spark'), 'codex_spark');
  assert.equal(classifyQuotaGroup('antigravity', 'gemini-4-neon-xhigh'), 'gemini');
  assert.equal(classifyQuotaGroup('antigravity', 'claude-opus-5-5-high'), 'claude_gpt');

  // Codex inputTokens includes cachedInputTokens; Antigravity cachedReadTokens is separate.
  const codexM = computeTurnMetrics({ engine: 'codex', usage: { inputTokens: 12000, outputTokens: 100, cachedInputTokens: 10000 } });
  assert.equal(codexM.totalTokens, 12100);
  assert.equal(codexM.weightedTokens, 2000 + 1000 + 400);

  const agyM = computeTurnMetrics({ engine: 'antigravity', usage: { inputTokens: 10000, outputTokens: 1000, cachedInputTokens: 50000 } });
  assert.equal(agyM.totalTokens, 61000);
  assert.equal(agyM.weightedTokens, 10000 + 5000 + 4000);

  const tracker = new UsageTracker(db, { flushIntervalMs: 0 });
  t.after(() => tracker.close());

  // Record traffic across different times
  tracker.recordTraffic(1, { httpIn: 1000, httpOut: 3000, wsIn: 500, wsOut: 500, requests: 2 }, now - 2 * 3600 * 1000);
  tracker.recordTraffic(2, { httpIn: 500, httpOut: 1500, requests: 1 }, now - 1 * 3600 * 1000);
  // Old traffic (10 days ago) should be excluded from 7d range, included in 30d/all
  tracker.recordTraffic(2, { httpIn: 100000, httpOut: 200000, requests: 50 }, now - 10 * 24 * 3600 * 1000);

  // Backfill historical turns from simulated u1/history.sqlite
  const u1Dir = join(dir, 'u1');
  mkdirSync(u1Dir, { recursive: true });
  const hdb = new DatabaseSync(join(u1Dir, 'history.sqlite'));
  hdb.exec('CREATE TABLE chat_events(session_id TEXT, seq INTEGER, ts INTEGER, event TEXT, PRIMARY KEY(session_id, seq))');
  hdb.prepare('INSERT INTO chat_events VALUES(?,?,?,?)').run(
    'sess-1', 5, now - 3600 * 1000,
    JSON.stringify({
      type: 'turn_end', engine: 'antigravity', model: 'gemini-4-neon-xhigh', ok: true,
      usage: { inputTokens: 60000, outputTokens: 10000, cachedInputTokens: 100000 },
      toolCalls: { total: 4, mutations: 1 }, durationMs: 25000,
    }),
  );
  hdb.close();
  assert.equal(tracker.backfillFromStateDir(dir, [1, 2]), 1);
  // Second backfill must be idempotent (0 duplicates)
  assert.equal(tracker.backfillFromStateDir(dir, [1, 2]), 0);

  // Live turns + measured Codex quota delta
  const codexResets5h = now + 4 * 3600 * 1000;
  const agyResets7d = now + 5 * 24 * 3600 * 1000;
  // Baseline Codex snapshot: 10% used
  tracker.observeQuotaSnapshot({
    engine: 'codex', label: 'Codex', status: 'ok',
    groups: [{
      id: 'codex', name: 'Codex 通用额度',
      windows: [{ id: 'codex:primary', label: '5 小时窗口', windowMinutes: 300, usedPercent: 10, usedPercentExact: 10, remainingPercent: 90, resetsAt: codexResets5h }],
    }],
  }, now - 60000);

  // Only Bob runs a Codex turn -> Codex jumps from 10% to 16% -> 6% directly measured to Bob!
  tracker.recordTurnStart(2, { turnId: 't-bob-1', engine: 'codex', model: 'gpt-5.4', startedAt: now - 40000 });
  tracker.recordTurnEnd(2, {
    turnId: 't-bob-1', engine: 'codex', model: 'gpt-5.4', ok: true,
    usage: { inputTokens: 20000, outputTokens: 2000, cachedInputTokens: 5000 },
    toolCalls: { total: 3 }, durationMs: 12000, ts: now - 20000,
  });
  const codexSnapAfter = {
    engine: 'codex', label: 'Codex', status: 'ok',
    groups: [{
      id: 'codex', name: 'Codex 通用额度',
      windows: [{ id: 'codex:primary', label: '5 小时窗口', windowMinutes: 300, usedPercent: 16, usedPercentExact: 16, remainingPercent: 84, resetsAt: codexResets5h }],
    }],
  };
  tracker.observeQuotaSnapshot(codexSnapAfter, now - 10000);

  // External CLI jump when no AnywhereMesh turn ran (16% -> 20%): must NOT be blamed on Alice or Bob!
  const codexSnapExt = {
    engine: 'codex', label: 'Codex', status: 'ok',
    groups: [{
      id: 'codex', name: 'Codex 通用额度',
      windows: [{ id: 'codex:primary', label: '5 小时窗口', windowMinutes: 300, usedPercent: 20, usedPercentExact: 20, remainingPercent: 80, resetsAt: codexResets5h }],
    }],
  };
  tracker.observeQuotaSnapshot(codexSnapExt, now + 60000);

  const users = [
    { id: 1, username: 'alice', isAdmin: true, deviceCount: 1, lastLoginAt: now },
    { id: 2, username: 'bob', isAdmin: false, deviceCount: 1, lastLoginAt: now },
  ];
  const quotaSnapshot = {
    fetchedAt: now + 60000,
    engines: [
      codexSnapExt,
      {
        engine: 'antigravity', label: 'Antigravity', status: 'ok',
        groups: [{
          id: 'gemini', name: 'Gemini 模型',
          windows: [{ id: 'gemini-weekly', label: '7 天窗口', windowMinutes: 10080, usedPercent: 8.5, usedPercentExact: 8.5, remainingPercent: 91.5, resetsAt: agyResets7d }],
        }],
      },
    ],
  };

  const sum7d = tracker.summary({ users, range: '7d', quotaSnapshot, now: now + 60000 });
  assert.equal(sum7d.totals.traffic.totalBytes, 7000);
  const alice7d = sum7d.accounts.find(a => a.username === 'alice');
  const bob7d = sum7d.accounts.find(a => a.username === 'bob');

  // Traffic separated & accurate
  assert.equal(alice7d.traffic.totalBytes, 5000);
  assert.equal(bob7d.traffic.totalBytes, 2000);
  assert.equal(alice7d.traffic.wsIn, 500);
  assert.equal(alice7d.traffic.wsOut, 500);

  // AI usage separated & accurate
  assert.equal(alice7d.ai.turns, 1);
  assert.equal(alice7d.ai.antigravityTurns, 1);
  assert.equal(alice7d.ai.totalTokens, 170000);
  assert.equal(bob7d.ai.turns, 1);
  assert.equal(bob7d.ai.codexTurns, 1);
  assert.equal(bob7d.ai.totalTokens, 22000);

  // Quota attribution:
  // Bob got exact 6% measured (not 20%, external CLI 4% and pre-baseline 10% were NOT falsely blamed on Bob!)
  const bobCodexQ = bob7d.quota.find(q => q.engine === 'codex' && q.windowId === 'codex:primary');
  assert.ok(bobCodexQ);
  assert.equal(bobCodexQ.consumedPercent, 6);
  assert.equal(bobCodexQ.source, 'measured');
  assert.equal(bobCodexQ.shareOfUsedPercent, 30); // 6 / 20 = 30%

  // Alice's historical Antigravity turn got 100% of the 8.5% Gemini weekly window via token-weighted estimation
  const aliceAgyQ = alice7d.quota.find(q => q.engine === 'antigravity' && q.windowId === 'gemini-weekly');
  assert.ok(aliceAgyQ);
  assert.equal(aliceAgyQ.consumedPercent, 8.5);
  assert.equal(aliceAgyQ.shareOfUsedPercent, 100);
  assert.equal(aliceAgyQ.source, 'estimated');

  // 30d range includes Bob's 10-day-old traffic
  const sum30d = tracker.summary({ users, range: '30d', quotaSnapshot, now: now + 60000 });
  assert.equal(sum30d.totals.traffic.totalBytes, 307000);
});

test('host /api/admin/usage enforces admin role, meters live HTTP + WS traffic, and includes quota pools', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-admin-usage-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authDir = join(dir, 'auth');
  const hostState = join(dir, 'host');
  const dev1State = join(dir, 'dev1');
  const dev2State = join(dir, 'dev2');
  const projDir = join(dir, 'proj');
  mkdirSync(authDir, { recursive: true });
  mkdirSync(hostState, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'sample.txt'), 'line 1\nline 2\n');
  const { certPath, keyPath } = makeCert(dir);

  // Mock Antigravity quota socket
  const agySock = join(dir, 'agy.sock');
  const agyServer = createServer(sock => {
    const rl = createInterface({ input: sock });
    rl.on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'anywhere/quota') {
        sock.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            command: {
              data: {
                groups: [{
                  name: 'Gemini Models',
                  buckets: [
                    { id: 'gemini-5h', window: '5h', remaining_fraction: 0.92, reset_time: new Date(Date.now() + 3 * 3600 * 1000).toISOString() },
                    { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.85, reset_time: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString() },
                  ],
                }],
              },
            },
          },
        }) + '\n');
      }
    });
  });
  await new Promise(resolve => agyServer.listen(agySock, resolve));
  t.after(() => agyServer.close());

  process.env.DATA_DIR = authDir;
  const { createUser } = await import('../auth.mjs');
  const { db } = await import('../auth-db.mjs');
  const { startServer } = await import('../host.mjs');
  const { DeviceClient } = await import('../client.mjs');

  createUser('usage-admin', 'admin strong pass', true);
  createUser('usage-member', 'member strong pass', false);
  const server = await startServer({
    host: '127.0.0.1', port: 0, cert: certPath, key: keyPath,
    stateDir: hostState,
    mcpPath: join(import.meta.dirname, '../wan/mcp.mjs'),
    antigravitySocket: agySock,
    antigravityCwd: dir,
  });
  t.after(async () => { await server.close(); db.close(); });

  const url = `https://127.0.0.1:${server.port}`;
  const adminClient = new DeviceClient({ name: 'Admin Dev', url, ca: certPath, stateDir: dev1State, projects: [{ label: 'P1', path: projDir }] });
  const memberClient = new DeviceClient({ name: 'Member Dev', url, ca: certPath, stateDir: dev2State, projects: [{ label: 'P2', path: projDir }] });
  t.after(async () => { await adminClient.suspend(); await memberClient.suspend(); });

  await adminClient.control('login', { username: 'usage-admin', password: 'admin strong pass' });
  await memberClient.control('login', { username: 'usage-member', password: 'member strong pass' });

  // Non-admin must be rejected
  await assert.rejects(() => memberClient.control('adminUsage', { range: '7d' }), /FORBIDDEN/);

  // Wait for member workspace WS handshake (generates WS RPC frames!)
  let memberState;
  for (let i = 0; i < 30; i++) {
    memberState = await memberClient.control('state');
    if (memberState.projects[0]?.ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(memberState.projects[0]?.ready);

  // Create a session and upload a 16 KiB attachment as member to generate noticeable HTTP ingress traffic
  const sess = await memberClient.control('create', {
    workspaceId: memberState.projects[0].id,
    requestId: '11111111-1111-4111-8111-111111111111',
    title: 'Traffic Test',
  });
  const payload = Buffer.alloc(16384, 'A').toString('base64');
  await memberClient.control('uploadAttachment', {
    sessionId: sess.id,
    name: 'blob.txt',
    mime: 'text/plain',
    dataBase64: payload,
  });

  const report = await adminClient.control('adminUsage', { range: '7d', refreshQuota: true });
  assert.equal(report.range, '7d');
  assert.equal(report.accounts.length, 2);
  assert.ok(report.quotaPools.length >= 2);
  assert.ok(report.quotaPools.some(p => p.engine === 'antigravity' && p.groupKey === 'gemini' && p.usedPercent === 8));

  const adminRow = report.accounts.find(a => a.username === 'usage-admin');
  const memberRow = report.accounts.find(a => a.username === 'usage-member');
  assert.ok(adminRow && memberRow);

  // Member uploaded 16 KiB + WS RPC handshake -> both HTTP and WS bytes > 0!
  assert.ok(memberRow.traffic.httpIn >= 16384, `expected member httpIn >= 16384, got ${memberRow.traffic.httpIn}`);
  assert.ok(memberRow.traffic.httpOut > 0, `expected member httpOut > 0, got ${memberRow.traffic.httpOut}`);
  assert.ok(memberRow.traffic.wsIn > 0, `expected member wsIn > 0, got ${memberRow.traffic.wsIn}`);
  assert.ok(memberRow.traffic.wsOut > 0, `expected member wsOut > 0, got ${memberRow.traffic.wsOut}`);
  assert.ok(memberRow.traffic.totalBytes > adminRow.traffic.totalBytes);
  assert.ok(memberRow.traffic.sharePercent > 50);
  assert.ok(Math.abs((memberRow.traffic.sharePercent + adminRow.traffic.sharePercent) - 100) <= 0.2);
});
