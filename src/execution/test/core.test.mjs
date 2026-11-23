import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.mjs';
import { LocalAgent, groupAlive, envelopeOf } from '../agent.mjs';
import { Broker } from '../broker.mjs';
import { MockRunner } from '../mock-runner.mjs';
import { hash, id, turnKey, resultDigest } from '../protocol.mjs';

const grant = { accountId: 'account', deviceId: 'device', workspaceId: 'workspace', grantVersion: 1, capabilities: ['mock.task'] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 5000) { const end = Date.now() + timeout; while (Date.now() < end) { const r = fn(); if (r) return r; await sleep(20); } throw new Error('TEST_TIMEOUT'); }
function setup(t, options = {}) {
  const path = mkdtempSync(join(tmpdir(), 'anywhere-execution-'));
  const journal = new Journal(join(path, 'journal.sqlite'));
  const agent = new LocalAgent(journal, grant, { stateDir: path, ...options }); agent.attach(1);
  t.after(async () => { await agent.close(); journal.close(); rmSync(path, { recursive: true }); });
  return { agent, journal, path };
}
function request(args = {}) {
  const request = { scope: { accountId: 'account', deviceId: 'device', workspaceId: 'workspace',
    grantVersion: 1, sessionId: 'session', turnId: 'turn', turnEpoch: 1 },
    toolCallId: id(), kind: 'mock.task', cwdRelative: '.', expiresAt: Date.now() + 60000,
    args: { steps: 3, intervalMs: 30, bytesPerStep: 20, exitCode: 0, spawnChild: false, ...args } };
  return { operationId: id(), requestHash: hash(request), request };
}

test('canonical request digest is independent of object key order', () => {
  assert.equal(hash({ a: 1, b: { x: 2, y: 3 } }), hash({ b: { y: 3, x: 2 }, a: 1 }));
});
test('structured executor exit without a result stays unknown and blocks retries', async (t) => {
  const { agent, journal } = setup(t, { launcher: () => ({ command: process.execPath,
    args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'], input: {} }) });
  const r = request(); agent.start(r);
  await until(() => journal.get('ops', r.operationId).state === 'unknown');
  assert.equal(agent.start(r).starts, 1);
  assert.throws(() => agent.start(request()), /WORKSPACE_RECOVERING/);
});
test('structured tool error cannot become success merely because the wrapper exited zero', async (t) => {
  const { agent, journal } = setup(t, { launcher: () => ({ command: process.execPath,
    args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>{require("fs").writeSync(3,JSON.stringify({version:1,ok:false,error:"tool_error"}))})'], input: {} }) });
  const r = request(); agent.start(r);
  const op = await until(() => { const o = journal.get('ops', r.operationId); return o.state === 'failed' && o; });
  assert.equal(op.result.tool.error, 'tool_error'); assert.equal(op.result.exitCode, 0);
});
test('reported executor completion survives cancellation during wrapper shutdown', async (t) => {
  const { agent, journal } = setup(t, { launcher: () => ({ command: process.execPath,
    args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>{require("fs").writeSync(3,JSON.stringify({version:1,ok:true}));setTimeout(()=>console.log("result-sent"),50);setInterval(()=>{},1000)})'], input: {} }) });
  const r = request(); agent.start(r);
  await until(() => journal.get('ops', r.operationId).lastSeq > 0);
  agent.cancel({ ...r, cancelId: id() });
  await until(() => journal.get('ops', r.operationId).state === 'succeeded');
});
test('concurrent retransmissions produce one stable task and one mock side effect', async (t) => {
  const { agent, journal, path } = setup(t), r = request();
  const a = agent.start(r), b = agent.start(r); assert.equal(a.taskId, b.taskId);
  const done = await until(() => { const o = journal.get('ops', r.operationId); return o.state === 'succeeded' && o; });
  assert.equal(done.starts, 1); assert.equal(agent.start(r).state, 'succeeded');
  assert.equal(readFileSync(join(path, 'mock-effects.jsonl'), 'utf8').trim().split('\n').length, 1);
});
test('same operation with changed parameters is rejected', (t) => {
  const { agent } = setup(t), r = request(); agent.start(r);
  const changed = structuredClone(r); changed.request.args.steps++; changed.requestHash = hash(changed.request);
  assert.throws(() => agent.start(changed), /OPERATION_CONFLICT/);
});
test('cancellation arriving before dispatch is a durable tombstone', (t) => {
  const { agent, journal } = setup(t), r = request();
  agent.cancel({ ...r, cancelId: 'cancel-first' });
  assert.equal(agent.start(r).state, 'cancelled'); assert.equal(journal.get('ops', r.operationId).starts, 0);
});
test('accepted task cancelled before scheduled launch never starts', async (t) => {
  const { agent, journal } = setup(t), r = request(); agent.start(r); agent.cancel({ ...r, cancelId: id() });
  await sleep(40); const op = journal.get('ops', r.operationId); assert.equal(op.state, 'cancelled'); assert.equal(op.starts, 0);
});
test('running cancellation confirms the fixed worker process group is gone', async (t) => {
  const { agent, journal } = setup(t), r = request({ steps: 200, spawnChild: true }); agent.start(r);
  const op = await until(() => { const o = journal.get('ops', r.operationId); return o.lastSeq > 1 && o; });
  assert.equal(agent.cancel({ ...r, cancelId: id() }).state, 'cancelling');
  await until(() => journal.get('ops', r.operationId).state === 'cancelled'); assert.equal(groupAlive(op.pid), false);
});
test('late cancellation preserves a durably confirmed successful result', async (t) => {
  const { agent, journal } = setup(t), r = request(); agent.start(r);
  await until(() => journal.get('ops', r.operationId).state === 'succeeded');
  assert.equal(agent.cancel({ ...r, cancelId: id() }).state, 'succeeded');
});
test('authorization is checked even for an existing operation', (t) => {
  const { agent } = setup(t), r = request(); agent.start(r);
  for (const field of ['accountId', 'deviceId', 'workspaceId', 'grantVersion']) {
    const bad = structuredClone(r); bad.request.scope[field] = field === 'grantVersion' ? 2 : 'other'; bad.requestHash = hash(bad.request);
    assert.throws(() => agent.start(bad), /SCOPE_DENIED/);
  }
});
test('unadvertised command/environment/path capabilities are refused', (t) => {
  const { agent } = setup(t);
  for (const modify of [(r) => r.request.args.command = 'sh', (r) => r.request.env = {},
    (r) => r.request.cwdRelative = '../', (r) => r.request.kind = 'run']) {
    const r = request(); modify(r); r.requestHash = hash(r.request);
    assert.throws(() => agent.start(r), /INVALID_FIELDS|CWD_DENIED|CAPABILITY_DENIED/);
  }
});
test('expired work is rejected, its identity remains deduplicated', (t) => {
  const { agent } = setup(t), r = request(); r.request.expiresAt = Date.now() - 1; r.requestHash = hash(r.request);
  assert.equal(agent.start(r).state, 'rejected'); assert.equal(agent.start(r).starts, 0);
});
test('a persisted stop fence refuses a late new operation in the same turn', (t) => {
  const { agent } = setup(t), r = request(); agent.stopTurn({ scope: r.request.scope, cancelId: id() });
  assert.throws(() => agent.start(r), /TURN_STOPPED/);
});
test('restart turns ambiguous states into unknown and fences new workspace work', async (t) => {
  const { agent, journal, path } = setup(t), r = request();
  journal.put('ops', r.operationId, { ...r, taskId: id(), state: 'running', starts: 1, lastSeq: 0 });
  const restarted = new LocalAgent(journal, grant, { stateDir: path }); restarted.attach(2);
  assert.equal(restarted.start(r).state, 'unknown');
  assert.throws(() => restarted.start(request()), /WORKSPACE_RECOVERING/);
  assert.equal(restarted.cancel({ ...r, cancelId: id() }).state, 'unknown');
  await restarted.close();
});
test('old connection epoch cannot start or cancel a task', (t) => {
  const { agent } = setup(t); agent.attach(2); const r = request();
  assert.throws(() => agent.handle('start', r, 1), /STALE_CONNECTION/);
  assert.throws(() => agent.handle('cancel', { ...r, cancelId: id() }, 1), /STALE_CONNECTION/);
  assert.throws(() => agent.attach(2), /STALE_CONNECTION/);
});
test('bounded output exposes truncation and keeps sequence numbers monotonic', async (t) => {
  const { agent, journal } = setup(t, { outputBytes: 4096 }), r = request({ steps: 20, bytesPerStep: 1024, intervalMs: 5 });
  agent.start(r); await until(() => journal.get('ops', r.operationId).state === 'succeeded');
  const out = agent.handle('output', { ...r, afterSeq: 0 }, 1);
  assert.ok(out.truncatedThrough > 0); assert.equal(out.rows[0].seq, out.firstAvailableSeq);
  assert.throws(() => agent.handle('ackOutput', { ...r, afterSeq: out.lastSeq + 1 }, 1), /INVALID_INTEGER/);
});
test('broker persists call identity and distinguishes displayed from consumed results', async (t) => {
  const { journal } = setup(t); const broker = new Broker(journal, grant); t.after(() => broker.close()); broker.phase = 'ready';
  const r = request(), params = { sessionId: 'session', turnId: 'turn', turnEpoch: 1,
    toolCallId: r.request.toolCallId, args: r.request.args, expiresAt: r.request.expiresAt };
  const op = broker.prepare(params); assert.equal(broker.prepare(params).operationId, op.operationId);
  assert.throws(() => broker.prepare({ ...params, args: { ...params.args, steps: 4 } }), /TOOL_CALL_CONFLICT/);
  const done = { ...op, taskId: id(), state: 'succeeded', result: { exitCode: 0 }, lastSeq: 0 };
  broker.merge(done);
  await broker.control('reasoningIdle', { sessionId: 'session', turnId: 'turn', turnEpoch: 1 });
  await broker.control('ackResult', { operationId: op.operationId, digest: resultDigest(done), stage: 'presented' });
  assert.throws(() => broker.prepare({ ...params, toolCallId: id() }), /WORKSPACE_RECOVERING/);
  assert.equal((await broker.control('session', paramsForTurn())).complete, false);
  await broker.control('ackResult', { operationId: op.operationId, digest: resultDigest(done), stage: 'consumed' });
  assert.equal((await broker.control('session', paramsForTurn())).complete, true);
  broker.close(); const restarted = new Broker(journal, grant); t.after(() => restarted.close()); restarted.phase = 'ready';
  assert.equal(restarted.prepare(params).operationId, op.operationId);
});
const paramsForTurn = () => ({ sessionId: 'session', turnId: 'turn', turnEpoch: 1 });

test('mock consumer crash after durable receipt only repeats the acknowledgement', async (t) => {
  const { journal } = setup(t), runner = new MockRunner(journal), r = request();
  const op = { ...r, taskId: id(), state: 'succeeded', result: { exitCode: 0 }, reason: null,
    lastSeq: 2, receivedSeq: 2, gaps: [] }; op.resultDigest = resultDigest(op);
  await assert.rejects(runner.consume(op, async () => { throw new Error('LOST_ACK'); }), /LOST_ACK/);
  const restarted = new MockRunner(journal); let acks = 0;
  await restarted.consume(op, async () => { acks++; });
  assert.equal(acks, 1); assert.equal(journal.all('consumed').length, 1);
});
