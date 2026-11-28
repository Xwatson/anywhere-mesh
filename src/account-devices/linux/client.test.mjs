import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxClient } from './client.mjs';
import { sessionConfig } from './network.mjs';
import {
  canMigrateLegacyRootIdentity,
  identifyLinuxRoot,
  linuxWorkspace,
  parseDfDevice,
  parseDiskutilVolumeUuid,
  resolveMacVolumeUuid,
} from '../linux-workspace.mjs';

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

test('LinuxClient workspacePath protects root and private paths, and sessionConfig validates profile', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'anywhere-linux-client-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'data');
  const defaultProj = join(root, 'project');
  const userRepo = join(dir, 'my-repo');
  const secretSub = join(root, 'state');
  mkdirSync(defaultProj, { recursive: true });
  mkdirSync(userRepo, { recursive: true });
  mkdirSync(secretSub, { recursive: true });
  const { certPath } = makeCert(dir);

  const client = new LinuxClient(
    { name: 'Linux Test', url: 'https://mesh.example.com', ca: certPath, stateDir: secretSub, projects: [{ label: 'Default', path: defaultProj }] },
    linuxWorkspace(),
    { peer: { child: null, stop: async () => {} }, privatePaths: [root] },
  );

  // Default project and ordinary user repo are allowed
  assert.equal(client.workspacePath(defaultProj), defaultProj);
  assert.equal(client.workspacePath(userRepo), userRepo);

  // Filesystem root, relative paths, private data root and parent dir of private root are rejected
  assert.throws(() => client.workspacePath('/'), /WORKSPACE_PATH_RESERVED/);
  assert.throws(() => client.workspacePath('relative/dir'), /LOCAL_PROJECT_REQUIRED/);
  assert.throws(() => client.workspacePath(root), /WORKSPACE_PATH_RESERVED/);
  assert.throws(() => client.workspacePath(secretSub), /WORKSPACE_PATH_RESERVED/);
  assert.throws(() => client.workspacePath(dir), /WORKSPACE_PATH_RESERVED/);

  // sessionConfig produces valid EasyTier config with no_tun and WSS peer
  const key = 'A'.repeat(43) + '=';
  const toml = sessionConfig(
    { name: 'mesh-net', serverKey: key, credential: key, ipv4: '10.203.73.10/24', expiresAt: Date.now() + 60000 },
    '11111111-2222-3333-4444-555555555555',
    41234,
    'https://mesh.example.com',
  );
  assert.match(toml, /uri = "wss:\/\/mesh\.example\.com\/easytier"/);
  assert.match(toml, /no_tun = true/);
  assert.match(toml, /bind_addr = "127\.0\.0\.1:41234"/);
});

test('LinuxClient negotiates direct HTTPS/WSS transport without starting EasyTier when server advertises direct', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'anywhere-linux-direct-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'data');
  const defaultProj = join(root, 'project');
  const stateDir = join(root, 'state');
  mkdirSync(defaultProj, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const { certPath } = makeCert(dir);

  let peerStarts = 0;
  const peer = {
    child: null,
    async start() { peerStarts++; this.child = {}; },
    async ready() {},
    async stop() { this.child = null; },
  };
  let seenNetworkReq = null;
  const progress = [];
  const client = new LinuxClient(
    { name: 'Linux Direct', url: 'https://mesh.example.com', ca: certPath, stateDir, projects: [{ label: 'Default', path: defaultProj }] },
    { ...linuxWorkspace(), onStream: evt => progress.push(evt) },
    {
      peer,
      privatePaths: [root],
      bootstrap: async (route, data) => {
        if (route === '/api/device/network') {
          seenNetworkReq = data;
          return { transport: 'direct' };
        }
        return {};
      },
    },
  );
  await client.ensureNetwork({ token: 'tok-123', deviceId: '11111111-2222-3333-4444-555555555555' });
  assert.equal(seenNetworkReq?.supportsDirect, true);
  assert.equal(peerStarts, 0);
  assert.equal(client.directMode, true);
  assert.equal(client.tunnelReady, true);
  assert.equal(client.cfg.url, 'https://mesh.example.com');
  assert.ok(progress.some(e => e.type === 'connect_progress' && e.payload?.phase === 'tunnel_readiness' && e.payload?.status === 'done'));

  // Transient HTTP failures in direct mode must never fall through to peer.ready()
  client.tunnelReady = false;
  peer.ready = async () => { throw Error('LINUX_NETWORK_EXITED'); };
  await client.ensureNetwork({ token: 'tok-123', deviceId: '11111111-2222-3333-4444-555555555555' });
  assert.equal(client.tunnelReady, true);
  assert.equal(peerStarts, 0);
});

test('macOS APFS volume UUID parsing, caching, and legacy identity migration helpers', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'anywhere-mac-root-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const file = join(dir, 'file.txt');
  const link = join(dir, 'link');
  mkdirSync(repo, { recursive: true });
  writeFileSync(file, 'hello\n');
  symlinkSync(repo, link);

  assert.equal(
    parseDfDevice('Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 965595304 12345 800000 14% /System/Volumes/Data\n'),
    '/dev/disk3s5',
  );
  assert.equal(
    parseDfDevice('Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk4s1 100 50 50 50% /Volumes/My External Drive\n'),
    '/dev/disk4s1',
  );
  assert.equal(
    parseDfDevice('Filesystem 512-blocks Used Available Capacity Mounted on\n//user@nas/share 100 50 50 50% /Volumes/share\n'),
    null,
  );
  assert.equal(parseDfDevice(''), null);

  const samplePlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>VolumeUUID</key>
  <string>5b3801c5-9e2b-4cdc-8828-1e50756f150a</string>
</dict></plist>`;
  assert.equal(parseDiskutilVolumeUuid(samplePlist), '5B3801C5-9E2B-4CDC-8828-1E50756F150A');
  assert.equal(
    parseDiskutilVolumeUuid('<plist><dict><key>FilesystemUUID</key><string>a1b2c3d4-1111-2222-3333-444455556666</string></dict></plist>'),
    'A1B2C3D4-1111-2222-3333-444455556666',
  );
  assert.equal(parseDiskutilVolumeUuid('<plist><dict><key>VolumeName</key><string>NoUUID</string></dict></plist>'), null);

  // Caching + transient failure fallback
  const cache = new Map();
  let nowMs = 1000;
  let calls = 0;
  let failRefresh = false;
  const fakeExec = (cmd, args) => {
    calls++;
    if (failRefresh) throw Error('diskarbitrationd busy');
    if (cmd === '/bin/df') {
      assert.deepEqual(args, ['-P', repo]);
      return 'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 100 10 90 10% /System/Volumes/Data\n';
    }
    if (cmd === '/usr/sbin/diskutil') {
      assert.deepEqual(args, ['info', '-plist', '/dev/disk3s5']);
      return samplePlist;
    }
    throw Error('unexpected command ' + cmd);
  };
  const first = resolveMacVolumeUuid(repo, 16777234n, { execSyncFn: fakeExec, cache, now: () => nowMs });
  assert.equal(first, '5B3801C5-9E2B-4CDC-8828-1E50756F150A');
  assert.equal(calls, 2);
  // Cached within TTL -> no subprocess calls
  nowMs += 5000;
  assert.equal(resolveMacVolumeUuid(repo, 16777234n, { execSyncFn: fakeExec, cache, now: () => nowMs }), first);
  assert.equal(calls, 2);
  // After TTL expires, transient diskutil failure retains cached UUID for same st.dev
  nowMs += 35000;
  failRefresh = true;
  assert.equal(resolveMacVolumeUuid(repo, 16777234n, { execSyncFn: fakeExec, cache, now: () => nowMs }), first);
  assert.equal(calls, 3);

  // identifyLinuxRoot on darwin uses stable vol:<UUID>:<ino> and falls back when no UUID is available
  const st = statSync(repo, { bigint: true });
  const macId = identifyLinuxRoot(repo, { platform: 'darwin', resolveVolumeUuid: () => first });
  assert.equal(macId, `vol:${first}:${st.ino.toString()}`);
  const fallbackId = identifyLinuxRoot(repo, { platform: 'darwin', resolveVolumeUuid: () => null });
  assert.equal(fallbackId, `${st.dev.toString()}:${st.ino.toString()}`);
  assert.throws(() => identifyLinuxRoot(file, { platform: 'darwin', resolveVolumeUuid: () => first }), /WORKSPACE_ROOT_CHANGED/);
  assert.throws(() => identifyLinuxRoot(link, { platform: 'darwin', resolveVolumeUuid: () => first }), /WORKSPACE_ROOT_CHANGED/);

  // Migration rules: only legacy <digits>:<sameIno> -> vol:<UUID>:<sameIno>
  assert.equal(canMigrateLegacyRootIdentity(`16777232:${st.ino.toString()}`, macId), true);
  assert.equal(canMigrateLegacyRootIdentity(`16777232:${(st.ino + 1n).toString()}`, macId), false);
  assert.equal(canMigrateLegacyRootIdentity(`vol:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE:${st.ino.toString()}`, macId), false);
  assert.equal(canMigrateLegacyRootIdentity(`16777232:${st.ino.toString()}`, `16777234:${st.ino.toString()}`), false);
});

test('LinuxClient auto-migrates legacy macOS st.dev:st.ino records after APFS reboot while rejecting replaced directories', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'anywhere-mac-migrate-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'data');
  const defaultProj = join(root, 'project');
  const userRepo = join(dir, 'stickman-animation');
  const replacedRepo = join(dir, 'replaced-repo');
  const stateDir = join(root, 'state');
  mkdirSync(defaultProj, { recursive: true });
  mkdirSync(userRepo, { recursive: true });
  mkdirSync(replacedRepo, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(userRepo, 'README.md'), 'hello stickman\n');
  const { certPath } = makeCert(dir);

  const defaultIno = statSync(defaultProj, { bigint: true }).ino.toString();
  const userIno = statSync(userRepo, { bigint: true }).ino.toString();
  const replacedWrongIno = (statSync(replacedRepo, { bigint: true }).ino + 99999n).toString();
  const secret = 'a'.repeat(64);
  const localDefaultId = randomUUID();
  const localUserId = randomUUID();
  const localReplacedId = randomUUID();
  const instFile = join(stateDir, 'installation.json');
  writeFileSync(instFile, JSON.stringify({
    secret,
    projects: [
      { path: defaultProj, inode: `16777232:${defaultIno}`, localId: localDefaultId },
      { path: userRepo, inode: `16777232:${userIno}`, localId: localUserId, label: 'stickman-animation' },
      { path: replacedRepo, inode: `16777232:${replacedWrongIno}`, localId: localReplacedId, label: 'replaced-repo' },
    ],
  }), { mode: 0o600 });

  const volumeUuid = '5B3801C5-9E2B-4CDC-8828-1E50756F150A';
  const baseWs = linuxWorkspace();
  const macIdentify = p => identifyLinuxRoot(p, { platform: 'darwin', resolveVolumeUuid: () => volumeUuid });
  const client = new LinuxClient(
    { name: 'Mac Test', url: 'https://mesh.example.com', ca: certPath, stateDir, projects: [{ label: 'Mac 本地项目', path: defaultProj }] },
    { ...baseWs, identifyRoot: macIdentify, canMigrateRoot: canMigrateLegacyRootIdentity },
    { peer: { child: null, stop: async () => {} }, privatePaths: [root] },
  );
  t.after(async () => { await client.disconnect(false); });

  const deviceId = randomUUID();
  const wsDefaultId = randomUUID();
  const wsUserId = randomUUID();
  const wsReplacedId = randomUUID();
  const signed = {
    token: 'tok-test',
    deviceId,
    user: { id: 8, username: 'xingxing' },
    projects: [
      { id: wsDefaultId, deviceId, localId: localDefaultId, label: 'Mac 本地项目', mode: 'revoked', ready: false },
      { id: wsUserId, deviceId, localId: localUserId, label: 'stickman-animation', mode: 'execute', ready: false },
      { id: wsReplacedId, deviceId, localId: localReplacedId, label: 'replaced-repo', mode: 'execute', ready: false },
    ],
  };
  client.signed = signed;
  client.attachProjects(signed, false);
  client.setMode(client.local(wsUserId), 'execute');

  const view = client.localState({ deviceId, projects: signed.projects.map(p => ({ ...p })) });
  const vDefault = view.projects.find(p => p.id === wsDefaultId);
  const vUser = view.projects.find(p => p.id === wsUserId);
  const vReplaced = view.projects.find(p => p.id === wsReplacedId);

  assert.equal(Boolean(vDefault.localUnavailable), false);
  assert.equal(Boolean(vUser.localUnavailable), false);
  assert.equal(vUser.localMode, 'execute');
  assert.equal(vReplaced.localUnavailable, true);
  assert.equal(vReplaced.ready, false);

  // Persisted installation.json has migrated the two matching directories and kept secret/localIds intact
  const saved = JSON.parse(readFileSync(instFile, 'utf8'));
  assert.equal(saved.secret, secret);
  assert.equal(saved.projects.find(p => p.localId === localDefaultId).inode, `vol:${volumeUuid}:${defaultIno}`);
  assert.equal(saved.projects.find(p => p.localId === localUserId).inode, `vol:${volumeUuid}:${userIno}`);
  assert.equal(saved.projects.find(p => p.localId === localReplacedId).inode, `16777232:${replacedWrongIno}`);

  // Migrated project's launcher accepts operations without WORKSPACE_ROOT_CHANGED
  const userLocal = client.local(wsUserId);
  assert.equal(userLocal.available, true);
  const launchOp = userLocal.agent.launcher({
    request: { kind: 'dc.tool', args: { tool: 'read_file', arguments: { path: 'README.md' } } },
  }, userLocal.agent.grant);
  assert.equal(launchOp.mutates, false);

  // Replaced directory (inode mismatch) is still rejected on registerWorkspace
  await assert.rejects(client.registerWorkspace(replacedRepo), /WORKSPACE_ROOT_CHANGED/);
});
