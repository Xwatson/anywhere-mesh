import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('admin user management and offline device cleanup enforce safety guards', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-admin-users-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authDir = join(dir, 'auth');
  const hostState = join(dir, 'host');
  const dev1State = join(dir, 'dev1');
  const dev2State = join(dir, 'dev2');
  const dev3State = join(dir, 'dev3');
  const projDir = join(dir, 'proj');
  mkdirSync(authDir, { recursive: true });
  mkdirSync(hostState, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'notes.txt'), 'hello\n');
  const { certPath, keyPath } = makeCert(dir);

  process.env.DATA_DIR = authDir;
  const { createUser } = await import('../auth.mjs');
  const { db } = await import('../auth-db.mjs');
  const { startServer } = await import('../host.mjs');
  const { DeviceClient } = await import('../client.mjs');

  const boss = createUser('boss-admin', 'boss strong pass', true);
  const member = createUser('dev-member', 'member strong pass', false);
  const server = await startServer({
    host: '127.0.0.1', port: 0, cert: certPath, key: keyPath,
    stateDir: hostState, mcpPath: join(import.meta.dirname, '../wan/mcp.mjs'),
  });
  t.after(async () => { await server.close(); db.close(); });

  const url = `https://127.0.0.1:${server.port}`;
  const adminClient = new DeviceClient({ name: 'Admin Box', url, ca: certPath, stateDir: dev1State, projects: [{ label: 'P1', path: projDir }] });
  const memberClient = new DeviceClient({ name: 'Member Box', url, ca: certPath, stateDir: dev2State, projects: [{ label: 'P2', path: projDir }] });
  t.after(async () => { await adminClient.suspend(); await memberClient.suspend(); });

  await adminClient.control('login', { username: 'boss-admin', password: 'boss strong pass' });
  await memberClient.control('login', { username: 'dev-member', password: 'member strong pass' });

  // Non-admin cannot access admin user or device cleanup routes
  await assert.rejects(() => memberClient.control('adminUsers'), /FORBIDDEN/);
  await assert.rejects(() => memberClient.control('pruneDevices'), /FORBIDDEN/);
  await assert.rejects(() => memberClient.control('createUser', { username: 'x1', password: 'strong pass 123', isAdmin: false }), /FORBIDDEN/);

  // Admin sees all accounts
  const initialUsers = await adminClient.control('adminUsers');
  assert.equal(initialUsers.length, 2);
  assert.ok(initialUsers.some(u => u.username === 'boss-admin' && u.isAdmin && u.deviceCount === 1));
  assert.ok(initialUsers.some(u => u.username === 'dev-member' && !u.isAdmin && u.deviceCount === 1));

  // Cannot demote sole admin or delete self
  await assert.rejects(() => adminClient.control('setUserAdmin', { userId: boss.id, isAdmin: false }), /LAST_ADMIN_PROTECTED/);
  await assert.rejects(() => adminClient.control('deleteUser', { userId: boss.id }), /CANNOT_DELETE_SELF/);

  // Create new account + reject duplicate username
  const fresh = await adminClient.control('createUser', { username: 'alice-new', password: 'alice strong pass', isAdmin: false });
  assert.equal(fresh.username, 'alice-new');
  assert.equal(fresh.isAdmin, false);
  await assert.rejects(() => adminClient.control('createUser', { username: 'alice-new', password: 'another pass 123', isAdmin: false }), /USERNAME_TAKEN/);

  // Promote, then demote alice-new
  const promoted = await adminClient.control('setUserAdmin', { userId: fresh.id, isAdmin: true });
  assert.equal(promoted.isAdmin, true);
  const demoted = await adminClient.control('setUserAdmin', { userId: fresh.id, isAdmin: false });
  assert.equal(demoted.isAdmin, false);

  // Reset member password revokes old session and allows new login
  await adminClient.control('resetUserPassword', { userId: member.id, password: 'member reset 999' });
  await memberClient.suspend();
  for (let i = 0; i < 20; i++) {
    const fl = await adminClient.control('admin');
    const md = fl.find(d => d.username === 'dev-member');
    if (md && !md.online) break;
    await new Promise(r => setTimeout(r, 100));
  }

  // Prune offline session-less devices removes member device, preserves online admin device
  const pruned = await adminClient.control('pruneDevices');
  assert.equal(pruned.removed, 1);
  const afterPrune = await adminClient.control('admin');
  assert.equal(afterPrune.some(d => d.username === 'dev-member'), false);
  assert.equal(afterPrune.some(d => d.username === 'boss-admin'), true);

  // New login with reset password works, then individual deleteDevice removes it
  const memberClient2 = new DeviceClient({ name: 'Member Box 2', url, ca: certPath, stateDir: dev3State, projects: [{ label: 'P3', path: projDir }] });
  t.after(() => memberClient2.suspend());
  const loginRes = await memberClient2.control('login', { username: 'dev-member', password: 'member reset 999' });
  await memberClient2.suspend();
  const delDev = await adminClient.control('deleteDevice', { id: loginRes.deviceId });
  assert.equal(delDev.ok, true);
  assert.equal((await adminClient.control('admin')).some(d => d.id === loginRes.deviceId), false);

  // Delete created user
  const removed = await adminClient.control('deleteUser', { userId: fresh.id });
  assert.equal(removed.ok, true);
  const finalUsers = await adminClient.control('adminUsers');
  assert.equal(finalUsers.some(u => u.id === fresh.id), false);
});
