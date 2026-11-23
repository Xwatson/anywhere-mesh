import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

// The controller is the same one used by the installed Electron desktop.
const base = join(process.env.LOCALAPPDATA, 'AnywhereMesh');
const launch = await readFile(join(base, 'Start-Anywhere.cmd'), 'utf8');
const appDir = launch.match(/runtime\\(app-[A-F0-9]+)\\src\\desktop/i)?.[1];
if (!appDir) throw Error('WINDOWS_RUNTIME_NOT_FOUND');
const controller = spawn(process.execPath, [join(base, 'runtime', appDir, 'src', 'account-devices', 'windows', 'controller.mjs')], {
  stdio: ['pipe','pipe','inherit'], windowsHide: true
});
const responses = createInterface({ input: controller.stdout })[Symbol.asyncIterator]();
const commands = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
let lastId = 0;
async function request(method, params) {
  const id = ++lastId;
  controller.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  const reply = await responses.next();
  if (reply.done) throw Error('WINDOWS_CONTROLLER_CLOSED');
  const value = JSON.parse(reply.value);
  if (value.id !== id || value.error) throw Error(value.error ?? 'INVALID_CONTROLLER_REPLY');
  return value.value;
}
async function call(method, params = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await request(method, params); }
    catch (error) {
      // DeviceClient signs out a failed attempt before reusing this installation's identity.
      if (method === 'login' && ['WINDOWS_TUNNEL_NOT_READY', 'NETWORK_TIMEOUT', 'ECONNRESET'].includes(error.message) &&
          attempt < 5) { await delay(600); continue; }
      if (!['state', 'history', 'create'].includes(method) || attempt >= 4 ||
          !['NETWORK_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT'].includes(error.message)) throw error;
      await delay(500 * attempt);
    }
  }
}
async function projectState(id, mode) {
  for (let i = 0; i < 45; i++) {
    const s = await call('state');
    const p = s.projects?.find(p => p.id === id && p.deviceId === s.deviceId);
    if (p?.ready && p.mode === mode && p.localMode === mode) return s;
    await delay(320);
  }
  throw Error('WINDOWS_GRANT_NOT_READY');
}
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const hash = text => createHash('sha256').update(text).digest('hex');
const file = 'codex-' + randomUUID() + '.txt';
const path = join(base, 'project', file), marker = 'WIN_' + randomBytes(24).toString('hex');
let workspaceId, created = false, loggedIn = false;
const watchdog = setTimeout(() => process.stdin.destroy(), 600000);
try {
  const req = await commands.next();
  const { username, password } = JSON.parse(req.value);
  assert.equal(username, 'lab-coder');
  assert.equal(JSON.parse((await responses.next()).value).event, 'ready');
  const { deviceId, user } = await call('login', { username, password });
  loggedIn = true;
  const initial = await call('state'), project = initial.projects.find(p => p.deviceId === deviceId);
  workspaceId = project.id;
  await projectState(workspaceId, 'revoked');
  await writeFile(path, marker + '\r\n', { flag: 'wx' });
  created = true;
  await call('permission', { workspaceId, mode: 'read' });
  const state = await projectState(workspaceId, 'read');
  const title = 'Codex CLI · Windows 只读验证';
  const session = state.sessions.find(s => s.title === title && s.workspaceId === workspaceId && s.deviceId === deviceId)
    ?? await call('create', { title, workspaceId, requestId: randomUUID() });
  if (session.activeTurnId) throw Error('SESSION_BUSY');
  const cursor = session.lastSeq;
  // Do not send the marker or its digest to the agent with the prompt.
  out({ phase: 'ready', file, accountId: String(user.id), deviceId, workspaceId, sessionId: session.id });
  const step = await commands.next();
  if (step.done) throw Error('VERIFICATION_CANCELLED');
  const result = JSON.parse(step.value);
  assert.equal(result.answerSha256, hash(marker));
  assert.equal(result.fileRevision, 'file-v1:' + hash(marker + '\r\n'));
  const { events } = await call('history', { sessionId: session.id, afterSeq: cursor });
  assert.ok(events.some(r => r.event.type === 'tool_call' && r.event.id === result.callId && r.event.status === 'completed' && r.event.output.includes(marker)));
  assert.ok(events.some(r => r.event.type === 'assistant_text' && r.event.text === marker));
  await call('permission', { workspaceId, mode: 'revoked' });
  await projectState(workspaceId, 'revoked');
  out({ phase: 'revoked', expectedSha256: hash(marker), historyVerified: true });
  await commands.next(); // Allow the server to check revocation while the device is online.
} finally {
  clearTimeout(watchdog);
  try {
    if (loggedIn) {
      if (workspaceId) await call('permission', { workspaceId, mode: 'revoked' }).catch(() => {});
      await call('logout');
    }
  } finally {
    controller.stdin.end();
    if (created) await unlink(path);
    process.stdin.pause();
  }
}
out({ phase: 'closed', signedOut: true, fixtureRemoved: true });
