import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { NetworkClient } from '../../../native/linux/network-helper/client.mjs';
import { control } from '../control.mjs';
import { groupAlive } from '../agent.mjs';
import { Journal } from '../journal.mjs';
import { MockRunner } from '../mock-runner.mjs';

const exec = promisify(execFile);
const run = async (...args) => (await exec(args[0], args.slice(1), { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = '/srv/anywhere-lab/execution-b';
const ctrl = (method, params = {}) => control(`${base}/broker/control.sock`, method, params);
const unit = (role) => `anywhere-execution-${role}.service`;
const svc = (action, ...roles) => run('sudo', '-n', 'systemctl', action, ...roles.map(unit));
const results = [], holders = [], archives = [];
const runId = new Date().toISOString().replace(/[^0-9]/g, '');
let runnerJournal, runner;
let relayStopped = false, mockStopped = false, failure;
const record = (name, details = {}) => { const row = { name, passed: true, ...details }; results.push(row); console.log(JSON.stringify(row)); };
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout; let error;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
    await sleep(100);
  }
  throw new Error(`CONDITION_TIMEOUT${error ? ': ' + error.message : ''}`);
}
const snapshot = () => ctrl('snapshot');
const getOp = async (operationId) => (await snapshot()).ops.find((o) => o.operationId === operationId);
const opUntil = (id, predicate, timeout) => until(async () => { const op = await getOp(id); return op && predicate(op) && op; }, timeout);
const ready = () => until(async () => (await snapshot()).phase === 'ready', 40000);
const complete = (id) => opUntil(id, (o) => ['succeeded', 'failed', 'cancelled', 'rejected'].includes(o.state) && o.receivedSeq === o.lastSeq);
const turn = (p) => ({ sessionId: p.sessionId, turnId: p.turnId, turnEpoch: p.turnEpoch });
function task(args = {}) {
  return { sessionId: randomUUID(), turnId: randomUUID(), turnEpoch: 1, toolCallId: randomUUID(),
    expiresAt: Date.now() + 180000, args: { steps: 8, intervalMs: 30, bytesPerStep: 32, exitCode: 0, spawnChild: false, ...args } };
}
const ack = async (op, stage = 'consumed') => stage === 'consumed' ?
  runner.consume(op, (params) => ctrl('ackResult', params)) : ctrl('ackResult', { operationId: op.operationId, digest: op.resultDigest, stage });
async function effects() {
  const output = await run('sudo', '-n', 'python3', '-c',
    `from pathlib import Path; p=Path('${base}/agent/mock-effects.jsonl'); print(p.read_text() if p.exists() else '',end='')`);
  return output ? output.split('\n').filter(Boolean).map(JSON.parse) : [];
}
async function fault(point) {
  await run('sudo', '-n', '-u', 'anywhere-exec-agent', 'python3', '-c',
    `from pathlib import Path;Path('${base}/agent/fault.json').write_text('${JSON.stringify({ point })}')`);
}
async function delay(ms) {
  for (const role of ['cn', 'us']) await run('docker', 'exec', `anywhere-helper-${role}-1`, 'tc', 'qdisc', 'replace', 'dev', 'eth0', 'root',
    ...(ms ? ['netem', 'delay', `${ms / 2}ms`] : ['fq_codel']));
}
async function stopRelay() { await run('docker', 'stop', '-t', '2', 'anywhere-helper-relay-1'); relayStopped = true; }
async function startRelay() { await run('docker', 'start', 'anywhere-helper-relay-1'); relayStopped = false; }
async function archive(label) {
  await svc('stop', 'agent', 'broker');
  const path = await run('sudo', '-n', 'python3', '/srv/anywhere-lab/source/experimental/execution/lab/archive-state.py', `${runId}-${label}`);
  archives.push(path);
}
await run('bash', '/srv/anywhere-lab/scripts/guest-guard.sh');
runnerJournal = new Journal(`/srv/anywhere-lab/artifacts/execution-b-mock-runner-${runId}.sqlite`);
runner = new MockRunner(runnerJournal);
try {
  // Never reuse an earlier run's operation IDs or silently erase its evidence.
  await archive('previous');
  for (const role of ['cn', 'us']) {
    const holder = await NetworkClient.connect(`/run/anywhere-network/${role}.sock`);
    holders.push(holder); await holder.acquire();
  }
  for (const holder of holders) await holder.waitConnected(30000);
  await run('docker', 'stop', '-t', '2', 'anywhere-helper-us-mock-1'); mockStopped = true;
  await svc('start', 'broker', 'agent'); await ready();
  for (const role of ['agent', 'broker']) {
    const pid = await run('systemctl', 'show', '-p', 'MainPID', '--value', unit(role));
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    assert.match(status, /CapEff:\s+0000000000000000/); assert.match(status, /NoNewPrivs:\s+1/); assert.doesNotMatch(status, /Uid:\s+0\s/);
    const ns = role === 'agent' ? 'cn' : 'us';
    assert.equal(await run('sudo', '-n', 'stat', '-Lc', '%i', `/proc/${pid}/ns/net`), await run('sudo', '-n', 'stat', '-Lc', '%i', `/run/anywhere-network/${ns}.netns`));
  }
  record('business_services_nonroot_zero_capabilities_in_separate_network_namespaces');
  await assert.rejects(run('sudo', '-n', '-u', 'anywhere-exec-agent', 'flock', '--nonblock', `${base}/agent/process.lock`, '/usr/bin/true'));
  record('kernel_lock_rejects_duplicate_local_agent');
  const negative = await run('sudo', '-n', 'systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--uid=lab',
    '--property=NetworkNamespacePath=/run/anywhere-network/cn.netns', '--property=NoNewPrivileges=yes', '--property=CapabilityBoundingSet=',
    '/usr/local/bin/node', '/srv/anywhere-lab/source/experimental/execution/lab/transport-negative.mjs');
  record('mtls_device_identity_and_protocol_capabilities', { checks: JSON.parse(negative) });

  const first = task();
  const duplicates = await Promise.all([ctrl('submit', first), ctrl('submit', first), ctrl('submit', first)]);
  assert.ok(duplicates.every((o) => o.operationId === duplicates[0].operationId));
  let done = await complete(duplicates[0].operationId); assert.equal(done.state, 'succeeded'); assert.equal(done.starts, 1);
  assert.equal((await effects()).filter((e) => e.operationId === done.operationId).length, 1);
  await assert.rejects(ctrl('submit', { ...first, args: { ...first.args, steps: 9 } }), /TOOL_CALL_CONFLICT/);
  await ack(done); record('concurrent_delivery_deduplicated_and_parameter_conflicts_rejected');

  const life = task({ steps: 60, intervalMs: 40 }); const lifeOp = await ctrl('submit', life);
  await ctrl('reasoningIdle', turn(life)); assert.equal((await ctrl('session', turn(life))).complete, false);
  done = await complete(lifeOp.operationId); await ack(done, 'presented');
  assert.equal((await ctrl('session', turn(life))).complete, false);
  await assert.rejects(ctrl('submit', task()), /WORKSPACE_RECOVERING/);
  await ack(done); assert.equal((await ctrl('session', turn(life))).complete, true);
  record('reasoning_idle_display_and_result_consumption_are_distinct');

  const before = await ctrl('prepare', task()); await ctrl('cancel', { operationId: before.operationId });
  done = await complete(before.operationId); assert.equal(done.state, 'cancelled'); assert.equal(done.starts, 0);
  assert.equal((await ctrl('dispatch', { operationId: before.operationId })).state, 'cancelled'); await ack(done);
  record('cancel_before_start_survives_later_dispatch');

  const running = await ctrl('submit', task({ steps: 500, intervalMs: 30, spawnChild: true }));
  const runningState = await opUntil(running.operationId, (o) => o.lastSeq > 2 && o.pid);
  await ctrl('cancel', { operationId: running.operationId });
  done = await complete(running.operationId); assert.equal(done.state, 'cancelled'); assert.equal(groupAlive(runningState.pid), false); await ack(done);
  record('running_cancel_confirms_worker_and_descendant_exit');

  const natural = await ctrl('submit', task()); done = await complete(natural.operationId);
  await ctrl('cancel', { operationId: natural.operationId }); await opUntil(natural.operationId, (o) => o.cancelConfirmed);
  assert.equal((await getOp(natural.operationId)).state, 'succeeded'); await ack(done);
  record('natural_completion_is_not_overwritten_by_late_cancel');

  const stopTask = task({ steps: 180, intervalMs: 500 }); const stopOp = await ctrl('submit', stopTask);
  await opUntil(stopOp.operationId, (o) => o.lastSeq > 0);
  const outageAt = Date.now(); await stopRelay();
  await until(async () => (await snapshot()).phase !== 'ready', 15000);
  const stopping = await ctrl('stopTurn', turn(stopTask)); assert.equal(stopping.stopConfirmed, undefined);
  await assert.rejects(ctrl('submit', { ...stopTask, toolCallId: randomUUID() }), /DEVICE_RECOVERING|TURN_STOPPED/);
  const remaining = 30000 - (Date.now() - outageAt); if (remaining > 0) await sleep(remaining);
  const relayOfflineMs = Date.now() - outageAt;
  await startRelay(); await ready(); done = await complete(stopOp.operationId); assert.equal(done.state, 'cancelled');
  await until(async () => (await ctrl('session', turn(stopTask))).status === 'stopped'); await ack(done);
  await assert.rejects(ctrl('submit', { ...stopTask, toolCallId: randomUUID() }), /TURN_STOPPED/);
  record('thirty_second_outage_offline_stop_and_reconnect_stop_fence', { relayOfflineMs, outageToCancelConfirmedMs: Date.now() - outageAt });

  const logsTask = task({ steps: 220, intervalMs: 15, bytesPerStep: 1024 }); const logsOp = await ctrl('submit', logsTask);
  await opUntil(logsOp.operationId, (o) => o.lastSeq >= 1); await stopRelay();
  await svc('kill', 'broker'); await sleep(4500); await svc('start', 'broker');
  await until(async () => (await snapshot()).phase !== 'ready');
  await assert.rejects(ctrl('submit', task()), /DEVICE_RECOVERING/);
  await startRelay(); await ready(); done = await complete(logsOp.operationId);
  assert.equal(done.state, 'succeeded'); assert.ok(done.gaps.length > 0);
  assert.equal((await ctrl('submit', logsTask)).operationId, logsOp.operationId);
  assert.equal((await effects()).filter((e) => e.operationId === logsOp.operationId).length, 1);
  await ack(done); record('offline_task_finishes_broker_restart_recovers_output_with_explicit_truncation', { outputSeq: done.lastSeq, gaps: done.gaps });

  await fault('drop_start_reply'); const lostParams = task({ steps: 40 });
  const lost = await ctrl('submit', lostParams); done = await complete(lost.operationId);
  assert.equal(done.starts, 1); assert.equal((await ctrl('submit', lostParams)).operationId, lost.operationId);
  assert.equal((await effects()).filter((e) => e.operationId === lost.operationId).length, 1); await ack(done);
  record('accepted_start_reply_lost_reconciles_without_reexecution');

  const restartParams = task({ steps: 100, intervalMs: 40 }); const restartOp = await ctrl('submit', restartParams);
  await opUntil(restartOp.operationId, (o) => o.lastSeq >= 1);
  await run('sudo', '-n', 'systemctl', 'kill', '--kill-whom=main', '--signal=KILL', unit('broker'));
  await until(async () => (await run('systemctl', 'show', '-p', 'ActiveState', '--value', unit('broker'))) === 'failed');
  await svc('start', 'broker'); await ready(); done = await complete(restartOp.operationId); await ack(done, 'presented');
  await svc('restart', 'broker'); await ready();
  await assert.rejects(ctrl('submit', task()), /WORKSPACE_RECOVERING/);
  assert.equal((await ctrl('submit', restartParams)).operationId, restartOp.operationId);
  await ack(await getOp(restartOp.operationId)); record('broker_sigkill_and_restart_preserve_mapping_and_unconsumed_result_barrier');

  const expired = await ctrl('submit', { ...task(), expiresAt: Date.now() - 100 }); done = await complete(expired.operationId);
  assert.equal(done.state, 'rejected'); assert.equal(done.starts, 0); await ack(done); record('expired_dispatch_never_starts');

  await delay(400); const delayedAt = Date.now();
  const delayed = await ctrl('submit', task({ steps: 3 })); done = await complete(delayed.operationId);
  assert.equal(done.state, 'succeeded'); await ack(done); await delay(0);
  record('four_hundred_ms_injected_round_trip_keeps_protocol_healthy', { completionMs: Date.now() - delayedAt });

  await writeFile('/srv/anywhere-lab/artifacts/execution-b-normal-snapshot.json', JSON.stringify(await snapshot(), null, 2) + '\n');
  for (const point of ['agent_after_accept', 'agent_after_intent', 'agent_after_spawn', 'agent_before_result']) {
    await archive(point); await svc('start', 'broker', 'agent'); await ready(); await fault(point);
    const params = task({ steps: 10 }); const op = await ctrl('submit', params);
    await until(async () => (await run('systemctl', 'show', '-p', 'ActiveState', '--value', unit('agent'))) === 'failed');
    const priorEffects = (await effects()).filter((e) => e.operationId === op.operationId);
    for (const row of priorEffects) assert.equal(groupAlive(row.pid), false);
    await svc('start', 'agent'); await ready(); const unknown = await opUntil(op.operationId, (o) => o.state === 'unknown');
    assert.equal((await ctrl('submit', params)).state, 'unknown');
    await assert.rejects(ctrl('submit', task()), /WORKSPACE_RECOVERING/);
    await ctrl('cancel', { operationId: op.operationId }); await sleep(400);
    assert.equal((await getOp(op.operationId)).state, 'unknown');
    assert.equal((await effects()).filter((e) => e.operationId === op.operationId).length, priorEffects.length);
    if (point === 'agent_before_result') assert.equal(priorEffects.length, 1);
    record(`crash_window_${point}_stays_unknown_and_blocks_replay`, { operationId: op.operationId,
      recordedStarts: unknown.starts, sideEffects: priorEffects.length });
  }
} catch (e) { failure = e; console.error(e.stack); }
finally {
  try { await svc('stop', 'agent', 'broker'); } catch (e) { failure ||= e; }
  try { await delay(0); } catch (e) { failure ||= e; }
  if (relayStopped) { try { await startRelay(); } catch (e) { failure ||= e; } }
  if (mockStopped) { try { await run('docker', 'start', 'anywhere-helper-us-mock-1'); } catch (e) { failure ||= e; } }
  for (const holder of holders) { try { await holder.close(); } catch (e) { failure ||= e; } }
  const report = { timestamp: new Date().toISOString(), runId, passed: !failure, realCli: false,
    mockHistoryReceipts: runnerJournal.all('consumed').length,
    results, archives, failure: failure?.message || null, cleanup: 'B services stopped, delay reset, stage A mock restored, helper leases released' };
  await writeFile('/srv/anywhere-lab/artifacts/execution-b-integration.json', JSON.stringify(report, null, 2) + '\n');
  runnerJournal.close();
}
if (failure) process.exitCode = 1;
