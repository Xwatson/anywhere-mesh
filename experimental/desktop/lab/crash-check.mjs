import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { DesktopController, BASE } from '../controller.mjs';
import { NetworkClient } from '../../../native/linux/network-helper/client.mjs';
import { control } from '../../execution/control.mjs';
const exec = promisify(execFile), sleep = ms => new Promise(r => setTimeout(r, ms));
const run = async (...a) => (await exec(a[0], a.slice(1), { timeout: 20000 })).stdout.trim();
async function until(fn) { const end = Date.now() + 50000; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } throw Error('CRASH_CHECK_TIMEOUT'); }
let controller, failure; const results = [], record = name => { results.push({ name, passed: true }); console.log(name); };
try {
  await run('bash', '/srv/anywhere-lab/scripts/guest-guard.sh');
  await run('sudo','-n','systemctl','start','anywhere-desktop-crash-test.service');
  await until(async () => (await run('systemctl','show','--value','-p','ActiveState','anywhere-desktop-crash-test.service')) === 'inactive');
  const start = JSON.parse(await readFile('/srv/anywhere-lab/artifacts/desktop-d-crash-start.json', 'utf8'));
  assert.ok(Date.now() - Date.parse(start.at) < 15000, 'crash cleanup must finish promptly, not wait for the task deadline');
  for (const role of ['agent','broker']) assert.equal(await run('systemctl','show','--value','-p','ActiveState',`anywhere-desktop-${role}.service`), 'inactive');
  for (const role of ['cn','us']) {
    const h = await NetworkClient.connect(`/run/anywhere-network/${role}.sock`);
    try { await until(async () => (await h.status()).phase === 'idle'); } finally { await h.close(); }
  }
  record('backend_sigkill_causes_ui_exit_and_systemd_stops_execution_cgroups_and_helper_leases');
  controller = new DesktopController(); await controller.init();
  assert.equal((await controller.request('state')).permission.mode, 'revoked');
  await controller.request('connect');
  await until(async () => (await controller.request('state')).connection === 'connected');
  const job = controller.getJob(start.jobId), before = await run('sudo','-n','-u','anywhere-exec-agent','cat',`${BASE}/workspace/long.starts`);
  await until(async () => { const t = await controller.request('task', { id: job.id }); return t.state === 'unknown' || t.consumed; });
  const op = await control(`${BASE}/broker/control.sock`, 'operation', { operationId: job.operationId });
  assert.equal(op.starts, 1);
  if ((await controller.request('task', { id: job.id })).state === 'unknown') {
    const preview = await controller.request('reviewPreview', { id: job.id });
    await controller.request('review', { id: job.id, digest: preview.digest,
      note: 'Crash test: execution cgroup stopped; inspected long.starts and observed no replay. Preserve unknown outcome and close the record.' });
  }
  await until(async () => (await controller.request('task', { id: job.id })).consumed);
  await sleep(1000); assert.equal(await run('sudo','-n','-u','anywhere-exec-agent','cat',`${BASE}/workspace/long.starts`), before);
  record('cold_restart_preserves_one_start_and_reconciles_or_locally_reviews_without_replay');
} catch (e) { failure = e; console.error(e.stack); }
finally {
  await controller?.shutdown().catch(e => { failure ??= e; });
  await writeFile('/srv/anywhere-lab/artifacts/desktop-d-crash-check.json', JSON.stringify({ passed: !failure, realCli: false, results, error: failure?.stack ?? null }, null, 2));
}
if (failure) process.exitCode = 1;
