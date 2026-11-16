import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { DesktopController, BASE } from '../controller.mjs';
import { control } from '../../execution/control.mjs';
const exec = promisify(execFile), sleep = ms => new Promise(r => setTimeout(r, ms));
const run = async (...args) => (await exec(args[0], args.slice(1), { timeout: 30000 })).stdout.trim();
const results = []; let controller, failure;
const record = (name, extra = {}) => { const row = { name, passed: true, ...extra }; results.push(row); console.log(JSON.stringify(row)); };
async function until(fn, timeout = 40000) { const end = Date.now() + timeout; let error;
  while (Date.now() < end) { try { const r = await fn(); if (r) return r; } catch (e) { error = e; } await sleep(150); }
  throw Error('WAIT_TIMEOUT ' + (error?.message ?? ''));
}
const ready = () => until(async () => { const s = await controller.request('state'); return s.connection === 'connected' && s.permission.synced; });
const mode = async value => { await controller.request('permission', { mode: value }); await ready(); };
async function job(action, expected = 'succeeded') {
  const { id } = await controller.request('run', { action });
  const result = await until(async () => { const r = await controller.request('task', { id }); return r.done && r.consumed && r; });
  assert.equal(result.state, expected, JSON.stringify(result)); return result;
}
try {
  controller = new DesktopController(); await controller.init();
  assert.equal((await controller.request('state')).connection, 'disconnected');
  await controller.request('permission', { mode: 'read' });
  let state = await controller.request('state'); assert.equal(state.permission.mode, 'read'); assert.equal(state.permission.synced, false);
  record('cold_desktop_is_offline_and_local_permission_works_without_cn_tunnel');
  await controller.request('connect'); await ready();
  await assert.rejects(controller.request('run', { action: 'build' }), /PERMISSION_REQUIRED/);
  await job('read'); await mode('edit'); await job('edit');
  record('real_mcp_read_and_guarded_edit_from_desktop_controller');
  await mode('execute'); const build = await job('build');
  assert.match(build.output, /BUILD_OK/); assert.match(build.output, /pass 2/);
  record('real_offline_sandbox_build_and_tests_are_saved_before_consumption');
  const long = await controller.request('run', { action: 'long' });
  await until(() => controller.getJob(long.id).operationId);
  await sleep(1500); await controller.request('cancel', { id: long.id });
  await until(async () => (await controller.request('task', { id: long.id })).consumed);
  assert.equal((await controller.request('task', { id: long.id })).state, 'cancelled');
  record('explicit_cancel_confirms_process_termination_before_displaying_cancelled');
  await controller.request('disconnect'); state = await controller.request('state');
  assert.equal(state.connection, 'disconnected'); assert.equal(state.permission.mode, 'revoked');
  await controller.request('permission', { mode: 'edit' }); await controller.request('connect'); await ready();
  await job('read');
  await run('sudo','-n','-u','anywhere-exec-agent','python3','-c', `from pathlib import Path;Path('${BASE}/agent/fault.json').write_text('{"point":"agent_before_result"}')`);
  const crash = await controller.request('run', { action: 'edit' });
  await until(async () => await run('systemctl','show','--value','-p','ActiveState','anywhere-desktop-agent.service') === 'failed');
  await run('sudo','-n','systemctl','start','anywhere-desktop-agent.service'); await ready();
  await until(async () => (await controller.request('task', { id: crash.id })).state === 'unknown');
  await assert.rejects(controller.request('reviewPreview', { id: crash.id }), /REVOKE_BEFORE_REVIEW/);
  await mode('revoked'); const preview = await controller.request('reviewPreview', { id: crash.id });
  await controller.request('review', { id: crash.id, digest: preview.digest, note: 'Desktop integration fault: local notes.txt contains one appended effect; acknowledge uncertainty without retry.' });
  await until(async () => (await controller.request('task', { id: crash.id })).consumed);
  const reviewed = await controller.request('task', { id: crash.id }); assert.equal(reviewed.state, 'reviewed'); assert.equal(reviewed.outcome, 'unknown');
  record('local_review_keeps_unknown_outcome_and_durable_receipt_unblocks_following_work');
  await mode('execute'); await job('read');
  const ids = (await controller.request('state')).tasks.map(t => t.id);
  await controller.shutdown();
  controller = new DesktopController(); await controller.init();
  state = await controller.request('state'); assert.equal(state.connection, 'disconnected'); assert.equal(state.permission.mode, 'revoked');
  assert.deepEqual(state.tasks.map(t => t.id), ids);
  await controller.request('connect'); await ready(); await sleep(2000);
  const snapshots = await control(`${BASE}/broker/control.sock`, 'snapshot');
  assert.ok(snapshots.ops.every(o => o.starts <= 1));
  record('restart_keeps_history_revokes_authority_and_never_replays_operations', { operations: snapshots.ops.length });
} catch (e) { failure = e; console.error(e.stack); }
finally {
  await controller?.shutdown().catch(e => { failure ??= e; });
  const after = await run('systemctl','show','--value','-p','ActiveState','anywhere-desktop-agent.service','anywhere-desktop-broker.service');
  if (after.split(/\s+/).filter(Boolean).join(',') !== 'inactive,inactive') failure ??= Error('DESKTOP_SERVICES_LEFT_ACTIVE: ' + after);
  if (!failure) record('shutdown_stops_only_desktop_services_and_restores_fixture');
  await writeFile('/srv/anywhere-lab/artifacts/desktop-d-integration.json', JSON.stringify({ passed: !failure, realCli: false, results, error: failure?.stack ?? null }, null, 2));
}
if (failure) process.exitCode = 1;
