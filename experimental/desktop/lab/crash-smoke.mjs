import { writeFile } from 'node:fs/promises';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function crashSmoke({ request, ready, backendPid }) {
  async function until(fn) { const end = Date.now() + 40000; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(150); } throw Error('CRASH_SETUP_TIMEOUT'); }
  await until(ready); await request('connect', {});
  await request('permission', { mode: 'execute' });
  await until(async () => { const s = await request('state', {}); return s.connection === 'connected' && s.permission.synced && !s.blockers; });
  const task = await request('run', { action: 'long' });
  await until(async () => (await request('task', task)).state === 'running'); await sleep(1200);
  await writeFile('/srv/anywhere-lab/artifacts/desktop-d-crash-start.json', JSON.stringify({ at: new Date().toISOString(), jobId: task.id, backendPid, testOnly: true }, null, 2));
  // Intentionally kill only our own VM experiment child. The owning UI must
  // exit, and its systemd ExecStopPost must stop the D execution cgroups.
  process.kill(backendPid, 'SIGKILL');
}
