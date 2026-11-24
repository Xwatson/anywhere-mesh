import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import contract from '../contract.cjs';
import { CodexTurns, normalizeCodexQuota } from '../../session-host/codex-turns.mjs';
import { AntigravityTurns, normalizeAntigravityQuota } from '../../session-host/antigravity-turns.mjs';

test('desktop contract validates quota route strictly', () => {
  assert.doesNotThrow(() => contract.validate('quota', {}));
  assert.doesNotThrow(() => contract.validate('quota', { refresh: true }));
  assert.doesNotThrow(() => contract.validate('quota', { refresh: false }));
  assert.throws(() => contract.validate('quota', { refresh: 'yes' }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('quota', { extra: 1 }), /INVALID_FIELDS/);
});

test('normalizeCodexQuota and CodexTurns.readQuota parse primary/secondary windows, extra limit groups and credits', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-quota-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sockPath = join(dir, 'codex.sock');

  const server = createServer(sock => {
    const rl = createInterface({ input: sock });
    const send = obj => sock.write(JSON.stringify(obj) + '\n');
    rl.on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') { send({ id: msg.id, result: {} }); return; }
      if (msg.method === 'account/rateLimits/read') {
        send({
          id: msg.id,
          result: {
            planType: 'prolite',
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1795450000 },
              secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1796000000 },
              credits: { hasCredits: true, unlimited: false, balance: '766.76' },
            },
            rateLimitsByLimitId: {
              codex: {
                primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1795450000 },
                secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1796000000 },
              },
              codex_spark: {
                limitName: 'GPT-5.3-Codex-Spark',
                primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1795450000 },
              },
            },
          },
        });
        return;
      }
      if (msg.method === 'account/read') {
        send({ id: msg.id, result: { planType: 'prolite', account: { email: 'hidden@example.com' } } });
      }
    });
  });
  await new Promise(resolve => server.listen(sockPath, resolve));
  t.after(() => server.close());

  const turns = new CodexTurns({ store: null }, sockPath, dir);
  const quota = await turns.readQuota();
  assert.equal(quota.engine, 'codex');
  assert.equal(quota.status, 'ok');
  assert.equal(quota.plan, 'Pro Lite');
  assert.equal(quota.credits.balance, '766.76');
  assert.equal(quota.groups.length, 2);
  assert.equal(quota.groups[0].name, 'Codex 通用额度');
  assert.equal(quota.groups[0].windows[0].label, '5 小时窗口');
  assert.equal(quota.groups[0].windows[0].usedPercent, 25);
  assert.equal(quota.groups[0].windows[0].remainingPercent, 75);
  assert.equal(quota.groups[0].windows[0].resetsAt, 1795450000 * 1000);
  assert.equal(quota.groups[0].windows[1].label, '7 天窗口');
  assert.equal(quota.groups[1].name, 'GPT-5.3-Codex-Spark');
  assert.equal(quota.groups[1].windows[0].remainingPercent, 90);
  assert.equal('account' in quota, false);

  const single = normalizeCodexQuota({
    rateLimits: {
      primary: { usedPercent: 40, windowDurationMins: 1440, resetsAt: '2026-11-25T00:00:00Z' },
      credits: { hasCredits: true, unlimited: false, balance: '13487.1356820000' },
    },
  });
  assert.equal(single.groups[0].windows[0].label, '1 天窗口');
  assert.equal(single.groups[0].windows[0].remainingPercent, 60);
  assert.equal(single.credits.balance, '13487.14');
});

test('normalizeAntigravityQuota and AntigravityTurns.readQuota handle CLI JSON, proto3 zero omission and fallback errors', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-quota-agy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sockPath = join(dir, 'agy.sock');

  const server = createServer(sock => {
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
                groups: [
                  {
                    groupName: 'Gemini Models',
                    buckets: [
                      { bucketId: 'gemini-5h', window: 'SHORT_TERM', remainingFraction: 0.91, resetTime: '2026-11-24T08:00:00Z' },
                      { bucketId: 'gemini-weekly', window: 'WEEKLY', resetTime: '2026-12-01T00:00:00Z' },
                    ],
                  },
                  {
                    groupName: 'Claude and GPT models',
                    buckets: [
                      { bucketId: '3p-5h', displayName: '5-Hour Window', remainingFraction: 0.4, resetTime: '2026-11-24T05:30:00Z' },
                    ],
                  },
                ],
              },
            },
          },
        }) + '\n');
      }
    });
  });
  await new Promise(resolve => server.listen(sockPath, resolve));
  t.after(() => server.close());

  const turns = new AntigravityTurns({ store: null }, sockPath, dir);
  const quota = await turns.readQuota();
  assert.equal(quota.engine, 'antigravity');
  assert.equal(quota.status, 'ok');
  assert.equal(quota.groups.length, 2);
  assert.equal(quota.groups[0].name, 'Gemini 模型');
  assert.equal(quota.groups[0].windows[0].label, '5 小时窗口');
  assert.equal(quota.groups[0].windows[0].remainingPercent, 91);
  assert.equal(quota.groups[0].windows[0].usedPercent, 9);
  // Proto3 omitted 0.0 remainingFraction treated as depleted (0% remaining)
  assert.equal(quota.groups[0].windows[1].label, '7 天窗口');
  assert.equal(quota.groups[0].windows[1].remainingPercent, 0);
  assert.equal(quota.groups[0].windows[1].usedPercent, 100);
  assert.equal(quota.groups[1].name, 'Claude / GPT 模型');
  assert.equal(quota.groups[1].windows[0].remainingPercent, 40);

  const shape2 = normalizeAntigravityQuota({
    response: {
      groups: [{ displayName: 'Gemini Models', buckets: [{ bucketType: 'FIVE_HOUR', remainingFraction: 0.85, resetTime: '2026-11-24T06:00:00Z' }] }],
    },
  });
  assert.equal(shape2.status, 'ok');
  assert.equal(shape2.groups[0].windows[0].remainingPercent, 85);

  const rawFallback = normalizeAntigravityQuota({ rawText: 'Gemini Models: 80% remaining' });
  assert.equal(rawFallback.status, 'ok');
  assert.equal(rawFallback.rawSummary, 'Gemini Models: 80% remaining');

  // Live agy 1.5.15 snake_case output with weekly before 5h must sort 5h first
  const liveShape = normalizeAntigravityQuota({
    command: {
      name: 'usage',
      data: {
        groups: [{
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.97999, reset_time: '2026-12-01T02:22:33Z' },
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.98, reset_time: '2026-11-24T07:22:33Z' },
          ],
        }],
      },
    },
  });
  assert.equal(liveShape.groups[0].windows[0].label, '5 小时窗口');
  assert.equal(liveShape.groups[0].windows[0].remainingPercent, 98);
  assert.equal(liveShape.groups[0].windows[1].label, '7 天窗口');
});
